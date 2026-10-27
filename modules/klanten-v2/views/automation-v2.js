// modules/klanten-v2/views/automation-v2.js
//
// SECTIE "AUTOMATION" (27 okt 2026, Maxim).
//
// Kiest een klant in zijn onboarding "Ja, bel mij" bij de automation-vraag, dan
// staat hier een kaart (opvolging_taken, lijst 'automation'). Bewust NIET meer
// tussen Daves gewone Opvolging-daglijst.
//
// Tabs: Te bellen · Ingepland · Afgerond · Alle. KPI-strip bovenaan.
// Data: GET /api/automation-overzicht (recht automation.view).
//
// HERGEBRUIK, GEEN KOPIE. Bellen (softphone, de poging telt zoals in
// Opvolging), WhatsApp (het gesprekspaneel), "Wat nu?", Call inplannen (agenda,
// booking_source automation, ook een eigen moment buiten de vrije slots),
// Gesprek gehad / Geen interesse (notitie verplicht), Later terugbellen en de
// historiek komen uit opvolging-v2.js via window.__opvGedeeld en de globale
// knoppen (__opvBel, __opvWa, __opvWatNu, __opvHist). Die vinden onze kaarten via
// de haak window.__opvAutomationZoek en legen onze cache via
// window.__opvAutomationVerander — net zoals Leads bellen. De acties lopen dus
// langs dezelfde endpoints (opvolging-taak-update, -poging, -agenda,
// softphone-call-log) met hun eigen Opvolging-rechten.

(function () {
  if (!window.DFO) return;
  window.DFO.VIEWS = window.DFO.VIEWS || {};

  const G = () => window.__opvGedeeld || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ZONE = 'Europe/Brussels';
  const TABS = [
    { tab: 'Te bellen', code: 'te_bellen' },
    { tab: 'Ingepland', code: 'ingepland' },
    { tab: 'Afgerond', code: 'afgerond' },
    { tab: 'Alle', code: 'alle' },
  ];
  const BELMOMENT = { voormiddag: 'Voormiddag', namiddag: 'Namiddag', avond: 'Avond', weekend: 'Zaterdag' };

  const st = window.__autState = window.__autState || { laden: false, data: null, fout: null, seq: 0, toonTest: false };

  const rerender = () => { if (typeof window.DFO.render === 'function') window.DFO.render(); };
  const mag = (k) => { try { return !!(window.RBAC && typeof window.RBAC.canSync === 'function' && window.RBAC.canSync(k)); } catch (_) { return false; } };

  async function laad() {
    if (st.laden) return;
    st.laden = true; st.fout = null;
    const seq = ++st.seq;
    rerender();
    try {
      const j = await window.KV.authedJson('/api/automation-overzicht' + (st.toonTest ? '?test=1' : ''));
      if (seq !== st.seq) return;
      st.data = j;
    } catch (e) {
      if (seq !== st.seq) return;
      st.fout = (e && e.message) || 'Het overzicht kon niet geladen worden.';
    } finally {
      if (seq === st.seq) { st.laden = false; rerender(); }
    }
  }

  function alleKaarten() {
    const t = (st.data && st.data.tabs) || {};
    return [].concat(t.te_bellen || [], t.ingepland || [], t.afgerond || []);
  }

  // ── Haken voor de gedeelde Opvolging-vensters ────────────────────────────
  window.__opvAutomationZoek = (id) => alleKaarten().find((k) => k.id === id) || null;
  // Na een actie in een gedeeld venster: opnieuw ophalen bij de volgende tekening.
  window.__opvAutomationVerander = () => { st.verouderd = true; };

  // ── Opmaak ────────────────────────────────────────────────────────────────
  const dagKort = (ymd) => {
    if (!ymd) return '—';
    try { return new Intl.DateTimeFormat('nl-BE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(String(ymd).slice(0, 10) + 'T12:00:00Z')); } catch (_) { return ymd; }
  };
  const moment = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-BE', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; }
  };
  const belmomentTekst = (b) => (Array.isArray(b) && b.length ? b.map((x) => BELMOMENT[x] || x).join(', ') : 'Geen voorkeur');
  const pogingTekst = (k) => {
    const delen = [];
    delen.push((k.bel_totaal || 0) + '× gebeld' + (k.bel_dagen ? ' (' + k.bel_dagen + ' dag' + (k.bel_dagen === 1 ? '' : 'en') + ')' : ''));
    if (k.wa_totaal) delen.push(k.wa_totaal + ' WhatsApp' + (k.wa_totaal === 1 ? '' : 's'));
    return delen.join(' · ');
  };

  function stijl() {
    if (document.getElementById('aut-stijl')) return;
    const el = document.createElement('style');
    el.id = 'aut-stijl';
    el.textContent = `
.aut .aut-kpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 14px}
.aut .aut-tegel{border:1px solid var(--o-line);border-radius:12px;padding:12px 14px;background:#fff}
.aut .aut-tegel b{display:block;font-size:22px;line-height:1.1;color:var(--o-ink)}
.aut .aut-tegel span{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--o-muted);margin-bottom:4px}
.aut .aut-tegel i{display:block;font-style:normal;font-size:12px;color:var(--o-muted);margin-top:3px}
.aut .aut-kaart{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--o-line);border-left:4px solid #6D3FD4;border-radius:12px;padding:12px 14px;margin:0 0 8px;background:#fff}
.aut .aut-kaart.dicht{border-left-color:#9ca3af}
.aut .aut-kaart.gepland{border-left-color:#0ea968}
.aut .aut-wie{flex:1;min-width:0}
.aut .aut-naam{font-weight:700;font-size:14.5px;color:var(--o-ink)}
.aut .aut-regel{font-size:12.5px;color:var(--o-muted);margin-top:3px;line-height:1.45}
.aut .aut-regel b{color:var(--o-ink);font-weight:600}
.aut .aut-knoppen{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;max-width:52%}
.aut .aut-chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:650;background:#efe9fc;color:#6D3FD4;margin-left:6px;vertical-align:1px}
.aut .aut-chip.grijs{background:#f0f1f4;color:#5b6472}
.aut .aut-chip.test{background:#fff4e5;color:#b45309}
.aut .aut-call{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;margin-top:4px}
.aut .aut-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.aut .aut-leeg{padding:22px;text-align:center;color:var(--o-muted);border:1px dashed var(--o-line);border-radius:12px}
.aut .aut-kop{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}
.aut .aut-kop .info{flex:1;min-width:220px;font-size:12.5px;color:var(--o-muted)}
@media (max-width:720px){.aut .aut-kpi{grid-template-columns:repeat(2,minmax(0,1fr))}.aut .aut-kaart{flex-direction:column}.aut .aut-knoppen{max-width:none;justify-content:flex-start}}
`;
    document.head.appendChild(el);
  }

  function kpiStrip(d) {
    const k = (d && d.kpi) || {};
    const tegel = (label, waarde, sub) => '<div class="aut-tegel"><span>' + esc(label) + '</span><b>' + esc(waarde) + '</b>' + (sub ? '<i>' + esc(sub) + '</i>' : '') + '</div>';
    return '<div class="aut-kpi" data-aut="kpi">' +
      tegel('Nieuw vandaag', k.nieuw_vandaag ?? 0, 'interesse uit de onboarding') +
      tegel('Te bellen', k.te_bellen ?? 0, k.later ? k.later + ' komt later terug' : 'staat vandaag klaar') +
      tegel('Ingepland deze week', k.ingepland_week ?? 0, 'calls van ma t/m zo') +
      tegel('Interesse → gesprek', k.conversie_pct == null ? '—' : String(k.conversie_pct).replace('.', ',') + '%',
        (k.gesprekken ?? 0) + ' van ' + (k.totaal ?? 0) + ' kregen een gesprek') +
      '</div>';
  }

  function knop(label, onclick, opties) {
    const o = opties || {};
    return '<button type="button" class="obtn' + (o.p ? ' p' : '') + '"' + (o.titel ? ' title="' + esc(o.titel) + '"' : '') +
      ' onclick="' + onclick + '">' + label + '</button>';
  }

  function callRegel(a) {
    if (!a) return '';
    return '<div class="aut-call"><span class="aut-dot" style="background:' + esc(a.kleur || '#9ca3af') + '"></span>' +
      '<b>' + esc(moment(a.scheduled_at)) + '</b> &middot; ' + esc(a.label || 'Gepland') +
      (a.handmatig ? ' <span class="aut-chip grijs" title="Zelf gekozen moment, buiten de vrije momenten van de agenda">eigen moment</span>' : '') +
      (a.verzet ? ' <span class="aut-chip grijs">verzet</span>' : '') + '</div>';
  }

  function kaartHtml(k) {
    const id = esc(k.id);
    const kanBellen = mag('opvolging.module.access');
    const kanWa = mag('opvolging.whatsapp.sturen');
    const kanAfronden = mag('opvolging.taak.afronden');
    const kanBoeken = mag('opvolging.agenda.boeken');
    const klasse = k.tab === 'afgerond' ? ' dicht' : k.tab === 'ingepland' ? ' gepland' : '';
    let h = '<div class="aut-kaart' + klasse + '" data-aut-kaart="' + id + '"><div class="aut-wie">';
    h += '<div class="aut-naam">' + esc(k.naam) +
      (k.is_test ? '<span class="aut-chip test">test</span>' : '') +
      (k.komt_terug_op ? '<span class="aut-chip grijs">terug op ' + esc(dagKort(k.komt_terug_op)) + '</span>' : '') +
      (k.tab === 'afgerond' ? '<span class="aut-chip grijs">' + esc(k.afgerond_label || 'Afgerond') + '</span>' : '') +
      '</div>';
    h += '<div class="aut-regel"><b>' + esc(k.traject || 'Traject onbekend') + '</b> &middot; start ' + esc(k.start_date ? dagKort(k.start_date) : 'nog niet bekend') +
      ' &middot; mentor ' + (k.mentor ? '<b>' + esc(k.mentor) + '</b>' : 'nog niet gekoppeld') + '</div>';
    h += '<div class="aut-regel">Belmoment: <b>' + esc(belmomentTekst(k.belmoment)) + '</b> &middot; interesse sinds ' + esc(moment(k.interesse_op)) +
      ' &middot; ' + esc(pogingTekst(k)) + '</div>';
    if (k.afspraak) h += callRegel(k.afspraak);
    if (k.tab === 'afgerond' && k.archief_reden) {
      h += '<div class="aut-regel">' + esc(k.archief_reden) + (k.gearchiveerd_at ? ' &middot; ' + esc(moment(k.gearchiveerd_at)) : '') + '</div>';
    }
    h += '</div><div class="aut-knoppen">';
    if (k.tab !== 'afgerond' && kanBellen && k.telefoon) h += knop('&#128222; Bellen', "window.__opvBel('" + id + "','automation')", { p: k.tab === 'te_bellen' });
    if (k.tab !== 'afgerond' && kanWa && k.telefoon) h += knop('&#128172; WhatsApp', "window.__opvWa('" + id + "')");
    if (k.tab === 'te_bellen' && kanBoeken) h += knop('&#128197; Call inplannen', "window.__autActie('" + id + "','inplannen')");
    if (k.tab === 'te_bellen' && kanAfronden) h += knop('Wat nu?', "window.__opvWatNu('" + id + "')");
    if (k.tab === 'ingepland' && kanAfronden) {
      h += knop('Gesprek gehad', "window.__autActie('" + id + "','gesprek_gehad')") +
        knop('Geen interesse', "window.__autActie('" + id + "','geen_interesse')");
    }
    h += knop('Historiek', "window.__opvHist('" + id + "')");
    if (k.onboarding_id) h += knop('Dossier &rarr;', "window.__autDossier('" + esc(k.onboarding_id) + "')", { titel: 'Het onboardingdossier van deze klant' });
    h += '</div></div>';
    return h;
  }

  function lijst(kaarten, leeg) {
    return kaarten.length ? kaarten.map(kaartHtml).join('') : '<div class="aut-leeg">' + leeg + '</div>';
  }

  function view(code) {
    const g = G();
    if (!g) return '<div class="pad"><div class="card"><div class="card-body">De module Opvolging is niet volledig geladen. Herlaad de pagina.</div></div></div>';
    g.stijl(); stijl();
    if (st.verouderd && !st.laden) { st.verouderd = false; queueMicrotask(laad); }
    if (!st.data && !st.laden && !st.fout) queueMicrotask(laad);

    let h = '<div class="opv aut">';
    h += '<div class="aut-kop"><div class="info">Klanten die in hun onboarding vroegen om gebeld te worden over de automation. ' +
      'Bellen, WhatsApp en inplannen werken zoals in Opvolging; de call krijgt de bron <b>Automation</b>.</div>' +
      '<label style="font-size:12.5px;color:var(--o-muted);display:inline-flex;gap:6px;align-items:center"><input type="checkbox" ' + (st.toonTest ? 'checked ' : '') +
      'onchange="window.__autTest(this.checked)"> testkaarten</label>' +
      knop(st.laden ? 'Laden&hellip;' : 'Vernieuwen', 'window.__autVernieuw()') + g.waLamp() + '</div>';
    if (st.fout) {
      h += '<div class="warn">' + esc(st.fout) + ' ' + knop('Opnieuw', 'window.__autVernieuw()') + '</div>';
    } else if (!st.data) {
      h += '<div class="agleeg">Laden&hellip;</div>';
    } else {
      const d = st.data;
      for (const m of d.meldingen || []) h += '<div class="warn2">' + esc(m) + '</div>';
      if (!mag('opvolging.module.access')) {
        h += '<div class="warn2">Bellen, WhatsApp en afsluiten lopen via de rechten van Opvolging; die heb je niet. Je kunt hier wel alles inzien.</div>';
      }
      h += kpiStrip(d);
      const t = d.tabs || {};
      if (code === 'te_bellen') {
        const nu = (t.te_bellen || []).filter((k) => !k.komt_terug_op);
        const later = (t.te_bellen || []).filter((k) => k.komt_terug_op);
        h += lijst(nu, 'Niemand te bellen. Nieuwe interesse uit de onboarding verschijnt hier meteen.');
        if (later.length) h += '<div class="sh"><h3>Later terugbellen</h3><span class="n">' + later.length + '</span></div>' + lijst(later, '');
      } else if (code === 'ingepland') {
        h += lijst(t.ingepland || [], 'Nog geen ingeplande gesprekken.');
      } else if (code === 'afgerond') {
        h += lijst(t.afgerond || [], 'Nog niets afgerond.');
      } else {
        h += lijst(alleKaarten().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))), 'Nog geen automation-interesse.');
      }
    }
    h += '</div>';
    return h + g.modalHtml() + g.waPaneelHtml() + g.gesprekPaneelHtml();
  }

  // ── Handlers ──────────────────────────────────────────────────────────────
  window.__autVernieuw = () => { st.fout = null; laad(); };
  window.__autTest = (aan) => { st.toonTest = !!aan; st.data = null; laad(); };
  window.__autActie = (id, welke) => {
    const g = G(); if (!g) return;
    if (welke === 'inplannen') g.openModal({ soort: 'inplannen', taakId: id });
    else g.openModal({ soort: 'auto-afsluit', taakId: id, uitkomst: welke });
  };
  window.__autDossier = (onboardingId) => {
    import('./modals/onboarding-detail.js?v=4')
      .then((m) => m.openOnboardingDetailModal({ onboardingId }))
      .catch((e) => { console.warn('[automation] dossier:', e && e.message); alert('Het dossier kon niet geopend worden.'); });
  };

  for (const { tab, code } of TABS) window.DFO.VIEWS['automation/' + tab] = () => view(code);

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('automation');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('automation');
})();
