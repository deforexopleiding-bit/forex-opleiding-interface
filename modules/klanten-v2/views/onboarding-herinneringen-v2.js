// modules/klanten-v2/views/onboarding-herinneringen-v2.js
//
// ONBOARDING › HERINNERINGEN (Maxim, 28 okt 2026) — de mails voor wie de
// onboarding nog niet invulde. Nooit tijdens de bedenktijd; de eerste op de
// dag na het vervallen ervan (dag 15), de tweede 7 dagen later, "bijna van
// start" op startdatum − 2, en op startdatum + 7 een signaal naar de
// administratie in plaats van nog een mail.
//
//   1. HOOFDSCHAKELAAR — standaard UIT. Alleen wie mag goedkeuren zet hem aan.
//   2. TEKSTEN — concept → Maxim keurt goed. Een wijziging zet een tekst terug
//      op concept. "Testmail naar mij" stuurt hem naar jezelf, nooit naar een
//      student.
//   3. VANDAAG — wat de cron vandaag zou doen, met de schakelaar "Geen
//      herinneringen" per student.
//   4. OUDE DOSSIERS — start > 30 dagen geleden, nooit ingevuld: één laatste
//      mail (knop, typ VERSTUUR), 7 dagen later automatisch afgerond.
//
// Data + acties: /api/onboarding-herinneringen (recht onboarding.admin;
// goedkeuren, schakelaar en oude dossiers: onboarding.herinneringen.goedkeuren).

(function () {
  'use strict';
  if (!window.DFO) return;
  window.DFO.VIEWS = window.DFO.VIEWS || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const API = '/api/onboarding-herinneringen';
  const ZONE = 'Europe/Brussels';
  const moment = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-BE', { timeZone: ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; }
  };
  const dag = (d) => {
    if (!d) return '—';
    try { return new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return d; }
  };
  const WAAROM = {
    bedenktijd_loopt: 'Bedenktijd loopt nog', voor_dag_15: 'Nog vóór dag 15', wacht_op_dag_22: 'Wacht op dag 22',
    alles_gehad: 'Alle herinneringen gehad', vandaag_al_gemaild: 'Vandaag al gemaild', te_dicht_bij_vorige: 'Te dicht bij de vorige',
    signaal_al_gezet: 'Signaal al gezet', signaal_al_open: 'Signaal al open in het LMS', oud_dossier: 'Oud dossier (zie onderaan)',
    geen_herinneringen: '"Geen herinneringen" staat aan', wil_annuleren: 'Open signaal: wil annuleren', incasso: 'In incasso',
    oude_automation_stuurt_dag_15: 'De oude automation stuurt dag 15', geen_aanmelddatum: 'Geen aanmelddatum',
    wacht_7_dagen: 'Laatste mail verstuurd, wacht 7 dagen', geen_oud_dossier: '—',
  };

  const st = window.__ohState = window.__ohState || { laden: false, data: null, fout: null, seq: 0, bezig: null, toonAlles: false };
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
      st.fout = e && e.status === 403 ? 'Geen toegang (recht onboarding.admin).' : foutTekst(e, 'De herinneringen konden niet geladen worden.');
    } finally {
      if (seq === st.seq) { st.laden = false; rerender(); }
    }
  }

  async function post(body, bezig) {
    st.bezig = bezig; rerender();
    try {
      return await window.KV.authedJson(API, { method: 'POST', body: JSON.stringify(body) });
    } finally {
      st.bezig = null; rerender();
    }
  }

  window.__ohGeen = async (id, aan) => {
    try {
      await post({ actie: 'geen_herinneringen', onboarding_id: id, aan }, 'geen:' + id);
      toast(aan ? '"Geen herinneringen" staat aan voor deze student.' : '"Geen herinneringen" staat uit.');
      laad();
    } catch (e) { toast(foutTekst(e, 'Mislukt.')); }
  };
  window.__ohOud = async () => {
    const n = (st.data.oude_dossiers || []).filter((o) => o.actie === 'laatste_mail').length;
    const typ = prompt(`De laatste herinnering gaat naar ${n} oude dossier(s) (lijst hierboven). 7 dagen later worden wie nog niet invulden automatisch afgerond en komen ze in de check-in.\n\nTyp VERSTUUR om te bevestigen.`);
    if (typ !== 'VERSTUUR') return;
    try {
      const j = await post({ actie: 'oude_dossiers', bevestiging: 'VERSTUUR' }, 'oud');
      toast(`Verstuurd: ${j.verstuurd.length}. Mislukt: ${j.mislukt.length}.`);
      laad();
    } catch (e) { toast(foutTekst(e, 'Versturen mislukt.')); }
  };
  window.__ohAlles = (v) => { st.toonAlles = !!v; rerender(); };
  window.__ohLaad = () => laad();

  function pill(kleur, tekst) {
    const k = { ok: 'var(--emerald)', warn: 'var(--amber,#B7791F)', neutral: 'var(--text-3)', danger: 'var(--rose,#b42318)' }[kleur] || 'var(--text-3)';
    return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid ${k};color:${k};font-size:11.5px;font-weight:600">${esc(tekst)}</span>`;
  }
  function knop(label, onclick, { p = false, uit = false, titel = '' } = {}) {
    return `<button type="button" class="btn ${p ? 'btn-primary' : 'btn-ghost'} btn-sm" ${uit ? 'disabled' : ''} title="${esc(titel)}" onclick="${onclick}">${esc(label)}</button>`;
  }

  const mt = window.KVMailTeksten.maak({
    api: API, sleutel: 'oh',
    codeUitleg: 'Een regel <span class="mono">{{onboarding.startcode}}</span> = de code groot in een kader; een regel <span class="mono">[knop: …]</span> = een knop naar www.deforexopleiding.nl/onboarding. Ook: <span class="mono">{{klant.voornaam}}</span>.',
    data: () => st.data,
    zetInstellingen: (i) => { st.data.instellingen = i; },
    opnieuw: () => laad(),
  });

  function schakelaarKaart(d) {
    const w = [];
    if (d.oude_automation && d.oude_automation.aan) {
      w.push({ html: `De automation <b>${esc(d.oude_automation.namen.join(', '))}</b> staat nog aan en mailt zelf op aanmelding + 15 dagen. Zolang ze aan staat, stuurt deze module herinnering 1 niet (geen twee mails op één dag). Zet ze uit in Onboarding-automations als deze module het overneemt.` });
    }
    if (!d.logboek) w.push({ ernst: 'rood', html: 'Het logboek ontbreekt: draai eerst <span class="mono">docs/sql-migrations/2026-10-28-onboarding-opvolgflow.sql</span>. Zonder logboek vertrekt er niets.' });
    return mt.schakelaar(d, {
      titel: 'Onboarding-herinneringen',
      uitleg: 'Nooit tijdens de bedenktijd. Dag 15 (de dag na het vervallen) · dag 22 · startdatum − 2 (niet binnen 3 dagen van een vorige) · startdatum + 7: geen mail meer, een signaal "geen reactie" naar de administratie. Elke ochtend ± 9u.',
      bevestig: 'Herinneringen AANZETTEN? Vanaf de volgende ochtend (± 9u) vertrekken de goedgekeurde herinneringen automatisch naar studenten.',
      waarschuwingen: w,
    });
  }

  function vandaagKaart(d) {
    const plan = d.plan || [];
    const doen = plan.filter((p) => p.actie !== 'niets');
    const tellers = {};
    for (const p of plan) if (p.actie === 'niets') tellers[p.waarom] = (tellers[p.waarom] || 0) + 1;
    const lijst = st.toonAlles ? plan : doen;
    let h = `<div class="card" style="margin-bottom:12px"><div class="card-body">`;
    h += `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>Vandaag (${esc(dag(d.vandaag))})</b><span style="font-size:12px;color:var(--text-3)">${doen.length} actie(s)${d.instellingen.aan ? '' : ' — de schakelaar staat uit, er vertrekt niets'}</span>`;
    h += `<label style="margin-left:auto;font-size:12px"><input type="checkbox" ${st.toonAlles ? 'checked' : ''} onchange="window.__ohAlles(this.checked)"> Toon alle open onboardings (${plan.length})</label></div>`;
    h += `<div style="font-size:12px;color:var(--text-3);margin:6px 0">${Object.entries(tellers).map(([k, n]) => esc(WAAROM[k] || k) + ': ' + n).join(' · ') || ''}</div>`;
    if (!lijst.length) return h + `<div style="font-size:12.5px;color:var(--text-3)">Vandaag niets te doen.</div></div></div>`;
    h += `<div style="overflow-x:auto"><table class="tbl" style="width:100%;font-size:12.5px"><thead><tr><th>Student</th><th>Start</th><th>Dag 15</th><th>Vandaag</th><th>Gehad</th><th>Geen herinneringen</th></tr></thead><tbody>`;
    for (const p of lijst) {
      const actie = p.actie === 'mail' ? pill('warn', (d.soorten.find((s) => s.soort === p.soort) || {}).label || p.soort)
        : p.actie === 'signaal' ? pill('danger', 'Signaal geen reactie') : `<span style="color:var(--text-3)">${esc(WAAROM[p.waarom] || p.waarom)}</span>`;
      const gehad = (p.log || []).map((l) => esc(l.soort.replace('_', ' ')) + ' ' + esc(dag(l.op)) + (l.status === 'mislukt' ? ' (mislukt)' : l.status === 'overgenomen' ? ' (oude automation)' : '')).join('<br>') || '—';
      const geen = p.geen_herinneringen;
      h += `<tr><td><b>${esc(p.klant || '—')}</b><div style="color:var(--text-3)">${esc(p.traject || '')}${p.mentor ? ' · ' + esc(p.mentor) : ''}</div></td>`;
      h += `<td>${esc(dag(p.start))}</td><td>${esc(dag(p.eerste_dag))}${p.bedenktijd === 'lopend' ? '<div style="color:var(--text-3)">bedenktijd loopt</div>' : ''}</td><td>${actie}</td><td>${gehad}</td>`;
      h += `<td><label style="white-space:nowrap"><input type="checkbox" ${geen ? 'checked' : ''} ${st.bezig ? 'disabled' : ''} onchange="window.__ohGeen('${esc(p.id)}', this.checked)"> ${geen ? esc((geen.door || '') + ' · ' + moment(geen.op)) : 'uit'}</label></td></tr>`;
    }
    return h + `</tbody></table></div></div></div>`;
  }

  function oudeKaart(d) {
    const oud = d.oude_dossiers || [];
    const mag = d.rechten && d.rechten.goedkeuren;
    const klaar = oud.filter((o) => o.actie === 'laatste_mail').length;
    let h = `<div class="card" style="margin-bottom:12px"><div class="card-body">`;
    h += `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>Oude dossiers</b><span style="font-size:12px;color:var(--text-3)">start meer dan 30 dagen geleden, onboarding nooit ingevuld — ${oud.length}</span><span style="margin-left:auto"></span>`;
    h += knop(st.bezig === 'oud' ? 'Bezig…' : `Laatste mail versturen (${klaar})`, 'window.__ohOud()', {
      p: true, uit: !mag || !klaar || !d.instellingen.aan || !d.instellingen.teksten.laatste.goedgekeurd || !!st.bezig,
      titel: !mag ? 'Alleen met het recht onboarding.herinneringen.goedkeuren.' : (!d.instellingen.aan ? 'De hoofdschakelaar staat uit.' : (!d.instellingen.teksten.laatste.goedgekeurd ? 'Keur eerst de tekst "Laatste herinnering" goed.' : '')),
    });
    h += `</div><div style="font-size:12px;color:var(--text-2);margin:6px 0 8px">Eén laatste herinnering; wie 7 dagen later nog niet invulde, wordt automatisch afgerond ("oud dossier zonder onboarding") en komt in de doelgroep van de check-in.</div>`;
    if (!oud.length) return h + `<div style="font-size:12.5px;color:var(--text-3)">Geen oude dossiers.</div></div></div>`;
    h += `<table class="tbl" style="width:100%;font-size:12.5px"><thead><tr><th>Student</th><th>Start</th><th>Stand</th></tr></thead><tbody>`;
    for (const o of oud) {
      const stand = o.actie === 'laatste_mail' ? 'Krijgt de laatste mail' : o.actie === 'afronden' ? 'Wordt vannacht afgerond' : (WAAROM[o.waarom] || o.waarom) + (o.laatste_op ? ' (' + dag(o.laatste_op) + ')' : '');
      h += `<tr><td><b>${esc(o.klant || '—')}</b><div style="color:var(--text-3)">${esc(o.traject || '')}${o.mentor ? ' · ' + esc(o.mentor) : ''}</div></td><td>${esc(dag(o.start))}</td><td>${esc(stand)}</td></tr>`;
    }
    return h + `</tbody></table></div></div>`;
  }

  function view() {
    if (!st.data && !st.laden && !st.fout) laad();
    if (st.fout) return `<div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.fout)} ${knop('Opnieuw', 'window.__ohLaad()')}</div></div>`;
    if (!st.data) return `<div class="card"><div class="card-body" style="color:var(--text-3)">Laden…</div></div>`;
    const d = st.data;
    return `<div data-testid="onboarding-herinneringen">${schakelaarKaart(d)}${vandaagKaart(d)}${oudeKaart(d)}
      ${mt.teksten(d)}</div>`;
  }

  window.DFO.VIEWS['onboarding/Herinneringen'] = view;
})();
