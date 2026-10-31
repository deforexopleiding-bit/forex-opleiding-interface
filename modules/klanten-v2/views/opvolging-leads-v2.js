// modules/klanten-v2/views/opvolging-leads-v2.js
//
// Opvolging → tab 'Leads bellen'.
//
// Trage momenten? Dave belt warme proefleads van de minicursus en de 7-daagse
// en laat ze een Zoom-call inplannen. Alles wordt bijgehouden, zodat Maxim kan
// nagaan of er genoeg moeite gedaan is voor iemand weggegooid wordt.
//
// Eigen bestand naast opvolging-v2.js (dat al 5800 regels telt). Het hergebruikt
// via window.__opvGedeeld de render met vingerafdruk, de gedeelde vensters
// (historiek, inplannen via de agenda, het WhatsApp-gesprek, agenda doorsturen)
// en via zoekTaak-haak window.__opvLeadsZoek de globale knoppen __opvBel,
// __opvWa, __opvHist. Niets daarvan is hier gekopieerd.
//
// Endpoints: /api/opvolging-leads?pot=…, /api/opvolging-leads-kaart,
//            /api/opvolging-taak-update, /api/opvolging-agenda-instelling.
//
// Een kaart ontstaat pas zodra Dave iets met een lead doet (bellen, WhatsApp,
// wat nu?): dan eerst POST /api/opvolging-leads-kaart, daarna de gewone weg
// met de taak_id. Zo blijft de privacylijst van de WhatsApp-brug klein.
//
// Vensters van deze tab sluiten ALLEEN via het kruisje (huisregel).
//
// APARTE LIJSTEN (27 okt): 'Lijst opladen' kan ook een eigen lijst maken. Die
// krijgt een chip achter de potten (pot = 'lijst:<id>'), toont alleen zijn
// eigen leads met dezelfde rijen en knoppen, en telt nergens anders mee.
// Archiveren haalt de chip weg; terug te vinden onder 'Gearchiveerd'.

(function () {
  if (!window.DFO) return;
  window.DFO.VIEWS = window.DFO.VIEWS || {};

  // 'belrij' is geen eigen pot maar de werklijst: alles wat NU aan de beurt
  // is, uit alle potten, in volgorde van prioriteit. Daar begint Dave altijd.
  const POTTEN = [
    { code: 'belrij', label: '\u25B6 Nu bellen', kleur: '#d92d20' },
    { code: 'terugbellen', label: 'Terugbelafspraken', kleur: '#7c4dff' },
    { code: 'verlopen', label: 'Termijn verlopen', kleur: '#e08700' },
    { code: 'bezig', label: 'In belronde', kleur: '#2f6bff' },
    { code: 'nieuw', label: 'Nieuw', kleur: '#0ea968' },
    { code: 'wacht', label: 'Wacht op inplanning', kleur: '#2f6bff' },
    { code: 'later', label: 'Opgeladen, komt later', kleur: '#6b7280' },
    { code: 'ingepland', label: 'Ingepland', kleur: '#0ea968' },
    { code: 'afgerond', label: 'Afgerond', kleur: '#6b7280' },
  ];
  const CATEGORIEEN = [
    ['geen_interesse', 'Geen interesse'], ['niet_bereikbaar', 'Niet bereikbaar'],
    ['foutief_nummer', 'Foutief nummer'], ['al_klant', 'Al klant / al geholpen'],
    ['geen_budget', 'Geen budget'], ['anders', 'Anders'],
  ];
  // Tweeling van AFROND_* in api/_lib/opvolging-leads-pot.js; de server
  // controleert hetzelfde. tests/opvolging-leads-view.test.js houdt ze gelijk.
  const AFROND_MIN_NOTITIE = 15;
  const AFROND_MIN_BEL = 2;
  const AFROND_MIN_BEL_DAGEN = 2;
  const AFROND_MIN_WA = 1;
  const AFROND_ZONDER_DREMPEL = ['foutief_nummer', 'al_klant'];

  const G = () => window.__opvGedeeld || null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const straks = (fn) => { const g = G(); if (g && g.straks) g.straks(fn); else queueMicrotask(fn); };
  const teken = () => { const g = G(); if (g && g.render) g.render(); else if (window.DFO.render) window.DFO.render(); };
  const toast = (m) => { const g = G(); if (g && g.opvToast) g.opvToast(m); else alert(m); };

  // ── Staat ────────────────────────────────────────────────────────────────
  const _ld = {
    pot: null,                       // gekozen pot; null = eerste met inhoud
    telling: { laden: false, data: null, fout: null },
    potten: {},                      // code → { laden, data, fout }
    rijen: new Map(),                // sleutel → rij (voor knoppen en zoekTaak)
    alleenWaarschuwing: false,
    inst: { laden: false, data: null, fout: null, bezig: false, melding: null },
    modal: null,                     // { soort, sleutel, ... }
    bezig: false,
    toonAlles: {},                   // sectie → true: hele sectie tonen
    uitleg: false,                   // 'Hoe werkt het?' open
    ronde: null,                     // belronde-modus: { gebeld, gestart, overgeslagen:Set }
    gesprek: null,                   // { sleutel, taakId, gezienActief, sinds }
    logboek: { dag: null, laden: false, data: null, fout: null },
    logTab: 'tijdlijn',
    archiefOpen: false,              // 'Gearchiveerd' (aparte lijsten) open
  };
  const NIEUW_ZICHTBAAR = 12;

  async function haal(url) {
    try {
      const j = await window.KV.authedJson(url);
      if (j && j.error) return { __error: j.error };
      return j;
    } catch (e) { return { __error: (e && ((e.body && e.body.error) || e.message)) || 'Netwerkfout', code: e && e.body && e.body.code }; }
  }
  async function post(url, body) {
    try {
      const j = await window.KV.authedJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (j && j.error) throw Object.assign(new Error(j.error), { code: j.code });
      return j;
    } catch (e) {
      const b = (e && e.body) || {};
      throw Object.assign(new Error(b.error || (e && e.message) || 'onbekende fout'), { code: b.code || (e && e.code) });
    }
  }

  async function laadTelling() {
    const st = _ld.telling;
    if (st.laden) return;
    st.laden = true; st.fout = null;
    const j = await haal('/api/opvolging-leads?pot=telling');
    st.laden = false;
    if (j.__error) st.fout = j.__error; else st.data = j;
    teken();
  }
  const isLijstPot = (code) => String(code || '').startsWith('lijst:');
  async function laadPot(code) {
    const st = _ld.potten[code] = _ld.potten[code] || { laden: false, data: null, fout: null };
    if (st.laden) return;
    st.laden = true; st.fout = null;
    const j = await haal(isLijstPot(code)
      ? '/api/opvolging-leads?pot=lijst&lijst=' + encodeURIComponent(code.slice(6))
      : '/api/opvolging-leads?pot=' + encodeURIComponent(code));
    st.laden = false;
    if (j.__error) st.fout = j.__error;
    else {
      st.data = j;
      // De telling komt met elke pot mee; zo blijven de tellers vers.
      _ld.telling.data = j;
      for (const r of j.items || []) _ld.rijen.set(sleutel(r), r);
      // Een aparte lijst heeft ook rijen buiten 'Nu aan de beurt'.
      for (const lijst of Object.values(j.secties || {})) for (const r of lijst || []) _ld.rijen.set(sleutel(r), r);
    }
    teken();
  }

  /** De belrij van waar Dave nu werkt: de aparte lijst die open staat, anders Nu bellen. */
  function huidigeBelrij() {
    const code = isLijstPot(_ld.pot) ? _ld.pot : 'belrij';
    return ((_ld.potten[code] || {}).data) || {};
  }
  async function laadInst() {
    const st = _ld.inst;
    if (st.laden) return;
    st.laden = true; st.fout = null;
    const j = await haal('/api/opvolging-agenda-instelling');
    st.laden = false;
    if (j.__error) st.fout = j.__error; else st.data = j;
    teken();
  }

  const sleutel = (r) => (r.kaart && r.kaart.taak_id) ? 't:' + r.kaart.taak_id : 'l:' + r.lead_id;

  function leegCache() {
    _ld.telling.data = null; _ld.telling.fout = null;
    _ld.potten = {};
    _ld.logboek.data = null; _ld.logboek.fout = null;
  }

  async function laadLogboek() {
    const st = _ld.logboek;
    if (st.laden) return;
    st.laden = true; st.fout = null;
    const j = await haal('/api/opvolging-leads-logboek' + (st.dag ? '?dag=' + encodeURIComponent(st.dag) : ''));
    st.laden = false;
    if (j.__error) st.fout = j.__error; else { st.data = j; if (!st.dag) st.dag = j.dag; }
    teken();
  }

  // ── Haken voor opvolging-v2.js ───────────────────────────────────────────
  // Een leadkaart in de vorm die zoekTaak() teruggeeft, zodat __opvBel,
  // __opvWa, __opvHist en het inplanvenster er zonder kopie op werken.
  window.__opvLeadsZoek = (id) => {
    for (const r of _ld.rijen.values()) {
      if (r.kaart && r.kaart.taak_id === id) {
        const k = r.kaart;
        return {
          id, lijst: 'leads', naam: r.naam, telefoon: k.telefoon || r.telefoon, email: r.email,
          status: k.status, bel_totaal: k.bel_totaal, bel_dagen: k.bel_dagen, wa_totaal: k.wa_totaal,
          bel_vandaag: k.bel_vandaag, wa_vandaag: k.wa_vandaag, pogingen: k.pogingen || [],
          badge_label: k.badge_label, bron_ref: {},
        };
      }
    }
    return null;
  };
  window.__opvLeadsVerander = () => leegCache();

  /** De knop rechtsboven in Vandaag, met badge = terugbellen + verlopen + nieuw heet/warm. */
  window.__opvLeadsKnop = () => {
    const R = window.RBAC;
    if (R && typeof R.canSync === 'function' && R.canSync('opvolging.leads.view') === false) return '';
    if (!_ld.telling.data && !_ld.telling.laden && !_ld.telling.fout) straks(laadTelling);
    const n = _ld.telling.data ? _ld.telling.data.badge : null;
    return '<button class="obtn leadsknop" onclick="window.__opvLb.naarTab()" title="Terugbellen + termijn verlopen + nieuwe hete en warme leads">' +
      '&#128222; Leads bellen' + (n ? ' <span class="lb-badge">' + esc(n) + '</span>' : '') + '</button>';
  };

  // ═════════════════════════════════════════════════════════════════════════
  // DE VIEW
  // ═════════════════════════════════════════════════════════════════════════
  // Dave begint ALTIJD in 'Nu bellen'. Vroeger opende de tab op de eerste
  // pot met inhoud, en dat was meestal Bezig: dezelfde mensen die niet
  // opnemen, terwijl de verse leads in Nieuw wachtten.
  function eerstePotMetInhoud() { return 'belrij'; }

  function leadsView() {
    const g = G();
    if (!g) {
      return '<div class="opv"><div class="warn">De module Opvolging is niet volledig geladen. Herlaad de pagina.</div></div>';
    }
    g.stijl(); lbStijl();
    const t = _ld.telling;
    if (!t.data && !t.laden && !t.fout) straks(laadTelling);
    const aantallen = t.data ? t.data.aantallen : null;
    const pot = _ld.pot || (aantallen ? eerstePotMetInhoud(aantallen) : null);
    const ps = pot ? _ld.potten[pot] : null;
    if (pot && (!ps || (!ps.data && !ps.laden && !ps.fout))) straks(() => laadPot(pot));

    let h = '<div class="opv lb">';
    h += '<div class="kop"><div class="info"><b>Begin altijd bij &ldquo;Nu bellen&rdquo;</b> en werk van boven naar onder. ' +
      'Wie niet opneemt, schuift vanzelf door naar zijn volgende belronde. ' +
      '<a href="javascript:void(0)" onclick="window.__opvLb.uitleg()">' + (_ld.uitleg ? 'Verberg uitleg' : 'Hoe werkt het?') + '</a></div>' +
      '<button class="obtn" onclick="window.__opvLb.import()">&#8679; Lijst opladen</button>' +
      g.waLamp() + '</div>';
    if (_ld.uitleg) h += uitlegBlok();
    h += dagstrip();
    if (t.fout) h += '<div class="warn">De potten konden niet geladen worden: ' + esc(t.fout) + '</div>';
    for (const m of (t.data && t.data.meldingen) || []) h += '<div class="warn2">' + esc(m) + '</div>';

    h += '<div class="lb-potten">' + POTTEN.map((p) => {
      // Bij Nu bellen: wat dringend is (de rest van Nieuw staat er ook in, maar onderaan).
      const n = p.code === 'belrij' && t.data && t.data.belrij ? t.data.belrij.dringend : (aantallen ? aantallen[p.code] : null);
      return '<button class="lb-pot' + (p.code === pot ? ' on' : '') + '" style="--pk:' + p.kleur + '" onclick="window.__opvLb.kiesPot(\'' + p.code + '\')">' +
        esc(p.label) + '<span class="n">' + (n == null ? '&middot;' : esc(n)) + '</span></button>';
    }).join('') + lijstChips(t.data && t.data.aparte_lijsten, pot) + '</div>';
    if (_ld.archiefOpen) h += archiefBlok(t.data && t.data.aparte_lijsten);

    if (!pot) h += '<div class="agleeg">Laden&hellip;</div>';
    else if (ps && ps.fout) h += '<div class="warn">' + esc(ps.fout) + ' <button class="obtn" onclick="window.__opvLb.herlaad()">Opnieuw</button></div>';
    else if (!ps || !ps.data) h += '<div class="agleeg">Laden&hellip;</div>';
    else h += isLijstPot(pot) ? lijstInhoud(ps.data) : potInhoud(pot, ps.data);

    h += logboekBlok();
    h += beheerBlok();
    h += '</div>';
    return h + leadsModalHtml() + g.modalHtml() + g.waPaneelHtml() + g.gesprekPaneelHtml() + g.doorstuurPaneelHtml();
  }

  /** Vandaag in één oogopslag — uit hetzelfde logboek als onderaan. */
  function dagstrip() {
    const st = _ld.logboek;
    if (!st.data && !st.laden && !st.fout) straks(laadLogboek);
    const d = st.data && st.data.dag === (st.data.vandaag || st.data.dag) ? st.data : null;
    if (!d || d.dag !== d.vandaag) return '';
    const v = d.kpi;
    const cel = (n, l, titel) => '<div class="lb-cel" title="' + esc(titel || '') + '"><b>' + esc(n) + '</b><span>' + esc(l) + '</span></div>';
    const w = _ld.telling.data && _ld.telling.data.week;
    const pct = w && w.pct != null ? w.pct + ' %' : '—';
    return '<div class="lb-strip">' +
      cel(v.leads_gebeld, 'leads gebeld vandaag', v.pogingen + ' belpogingen in ' + v.rondes + ' rondes') +
      cel(v.opgenomen, 'lijn opgenomen', 'De lijn kwam tot stand. Een voicemail telt hier mee tot je na de call Voicemail of Geen gehoor aanklikt.') +
      cel(v.geen_gehoor + v.voicemail, 'geen gehoor / voicemail') +
      cel(v.ingepland, 'ingepland') + cel(v.doorgestuurd, 'agenda gestuurd') +
      '<div class="lb-cel breed"><b>' + esc(pct) + '</b><span>agenda gestuurd &rarr; zelf ingepland (7 d' +
      (w ? ', ' + esc(w.ingepland) + '/' + esc(w.doorgestuurd) : '') + ')</span></div></div>';
  }

  const POT_UITLEG = {
    belrij: 'Alles wat NU aan de beurt is, in volgorde. Werk van boven naar onder. Wie je net probeerde staat er even niet in: die komt terug in zijn volgende ronde.',
    terugbellen: 'Alle afspraken om terug te bellen. Op de afgesproken dag staan ze bovenaan in Nu bellen.',
    verlopen: 'Ze kregen de agenda maar plantten binnen 48 uur niets in. Nog eens bellen of de link opnieuw sturen.',
    bezig: 'Al geprobeerd, nog geen uitkomst. Ze komen vanzelf terug in Nu bellen op het moment van hun volgende ronde.',
    nieuw: 'Nog niet aangeraakt. Warmste bovenaan. De verse en hete staan ook in Nu bellen.',
    wacht: 'Agenda doorgestuurd; ze kiezen zelf. Na 48 uur zonder afspraak komen ze terug in Termijn verlopen.',
    later: 'Opgeladen lijsten, gedoseerd: ze komen op hun dag vanzelf in Nu bellen.',
    ingepland: 'Gelukt — laatste 30 dagen.',
    afgerond: 'Weggegooid in de laatste 60 dagen, met de moeite die ervoor gedaan is.',
  };

  function potInhoud(pot, d) {
    const items = d.items || [];
    if (pot === 'belrij') return belrijInhoud(d);
    let h = '<div class="ronde">' + esc(POT_UITLEG[pot] || '') + '</div>';
    if (pot === 'nieuw' && (d.niet_getoond || []).length) {
      h += '<div class="lb-weg">' + d.niet_getoond.map((r) =>
        '<span>' + esc(r.aantal) + ' niet getoond omdat ' + esc(r.tekst) + '</span>').join(' &middot; ') + '</div>';
    }
    if (pot === 'afgerond') return h + afgerondTabel(items);
    if (!items.length) return h + '<div class="agleeg">Niets in deze pot.</div>';
    return h + items.map((r) => leadRij(r, pot)).join('');
  }

  const LABEL_KLEUR = { heet: 't-red', warm: 't-amber', lauw: 't-blue', koud: 't-grey' };

  /**
   * De tag met de naam van de aparte lijst, naast de bestaande badge. Een
   * verhuisde kaart houdt zijn oude badge ('Minicursus', '7-daagse'); zo ziet
   * Maxim toch waarom hij in de lijst staat. Niet als de badge al de lijstnaam is.
   */
  // Vergelijken zoals een mens leest: unicode gelijkgetrokken (NFKC), elke
  // witruimte (ook harde spatie / zero-width) als één spatie, getrimd en
  // hoofdletterongevoelig.
  const zelfdeTekst = (a, b) => {
    const n = (v) => String(v == null ? '' : v).normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]+/g, ' ').trim().toLowerCase();
    return n(a) !== '' && n(a) === n(b);
  };
  function lijstTag(r) {
    const k = r && r.kaart;
    const naam = String((k && k.aparte_lijst_naam) || '').trim();
    if (!naam) return '';
    // De grijze badge op de rij is r.product_label (bij een importkaart =
    // badge_label van de kaart, bij een leadkaart het product van de lead).
    if (zelfdeTekst(r.product_label, naam) || zelfdeTekst(k.badge_label, naam)) return '';
    return ' <span class="tag lb-lijsttag" title="Staat in de aparte lijst ' + esc(naam) + '">&#128203; ' + esc(naam) + '</span>';
  }

  function leadRij(r, pot) {
    const k = r.kaart;
    const s = sleutel(r);
    const chips = (r.chips || []).slice(0, 3).map((c) =>
      '<span class="lb-chip ' + esc(c.soort || '') + '">' + esc(c.tekst) + '</span>').join('');
    const aangemeld = r.aangemeld_dagen == null ? '' : (r.aangemeld_dagen <= 0 ? 'vandaag aangemeld' :
      r.aangemeld_dagen === 1 ? 'gisteren aangemeld' : 'aangemeld ' + r.aangemeld_dagen + ' dagen geleden');
    const pil = k ? ('<span class="lb-pil">&#9742; ' + esc(k.bel_totaal) + ' op ' + esc(k.bel_dagen) + ' d</span>' +
      '<span class="lb-pil ' + (k.wa_totaal ? 'groen' : '') + '">WhatsApp ' + esc(k.wa_totaal) + '</span>') : '';
    let extra = '';
    if (k && k.plan && k.plan.reageerde && k.plan.antwoord) {
      extra += '<div class="lb-noot lb-antwoord">&#128172; &ldquo;' + esc(k.plan.antwoord) + '&rdquo;</div>';
    }
    if (k && k.wa_mislukt) extra += '<div class="lb-noot" style="color:var(--o-red)">&#9888; ' + esc(k.wa_mislukt) + '</div>';
    const vandaagD = (_ld.telling.data && _ld.telling.data.vandaag) || '';
    if (k && (pot === 'terugbellen' || r.sectie === 'terugbellen')) {
      const isVandaag = !vandaagD || String(k.due) <= vandaagD;
      extra += '<div class="lb-noot"><span class="tag ' + (isVandaag ? 't-red' : 't-purple') + '">' +
        (isVandaag ? 'vandaag terugbellen' : 'terugbellen op ' + esc(datumNl(k.due))) + '</span>' +
        (k.terugbel_notitie ? ' &#128221; ' + esc(k.terugbel_notitie) : '') + '</div>';
    }
    if (k && pot === 'later') extra += '<div class="lb-noot">Komt in Nu bellen op ' + esc(datumNl(k.due)) + '</div>';
    if (k && k.plan && ['bezig', 'verlopen', 'terugbellen'].includes(pot) && (k.plan.rondes || k.plan.handmatig)) {
      const p = k.plan;
      extra += '<div class="lb-noot lb-plan">Ronde ' + esc(p.rondes) + ' van ' + RONDES_MAX + ' gedaan' +
        (p.klaar ? ' &middot; <b>nu aan de beurt</b>' : ' &middot; volgende ronde <b>' + esc(momentKort(p.volgende_at)) + '</b>') +
        (p.uitgebeld ? ' &middot; <span style="color:var(--o-red)">uitgebeld</span>' : '') + '</div>';
    }
    if (k && k.uitkomsten && k.uitkomsten.length && pot !== 'afgerond') {
      const u = k.uitkomsten[k.uitkomsten.length - 1];
      extra += '<div class="lb-noot zacht">Laatst: ' + esc(u.tekst || u.soort) + ' &middot; ' + esc(momentKort(u.op, true)) + '</div>';
    }
    if (k && pot === 'wacht') {
      extra += '<div class="lb-noot"><span class="tag ' + (k.resterende_uren ? 't-blue' : 't-red') + '">' +
        (k.resterende_uren ? 'nog ' + esc(k.resterende_uren) + 'u van 48' : 'termijn voorbij') + '</span>' +
        (k.laatste_herinnering_at ? ' &middot; herinnering gestuurd' : '') + '</div>';
    }
    if (k && pot === 'ingepland' && k.afspraak_ref && k.afspraak_ref.scheduled_at) {
      extra += '<div class="lb-noot">&#9989; Call op ' + esc(momentNl(k.afspraak_ref.scheduled_at)) + '</div>';
    }

    let knoppen = '';
    const uitkomstKnop = k && k.plan && k.plan.uitkomst_open && pot !== 'ingepland' && pot !== 'afgerond'
      ? '<button class="obtn lb-uk" onclick="window.__opvLb.uitkomst(\'' + s + '\')" title="Je belde vandaag maar vulde nog niet in hoe het ging">&#9998; Uitkomst</button>' : '';
    if (pot === 'wacht') {
      knoppen = '<button class="obtn wa" onclick="window.__opvLb.herinnering(\'' + s + '\')">&#128233; Herinnering sturen</button>' +
        '<button class="obtn" onclick="window.__opvLb.bel(\'' + s + '\')">&#9742; Bel</button>';
    } else if (pot === 'ingepland') {
      knoppen = '<button class="obtn" onclick="window.__opvLb.hist(\'' + s + '\')">Historiek</button>';
    } else {
      knoppen = '<button class="obtn p" onclick="window.__opvLb.bel(\'' + s + '\')">&#9742; Bel</button>' +
        '<button class="obtn wa" onclick="window.__opvLb.wa(\'' + s + '\')">&#128172; WhatsApp</button>' +
        '<button class="obtn" onclick="window.__opvLb.watNu(\'' + s + '\')">Wat nu?</button>';
    }
    if (r.sectie === 'uitgebeld') {
      knoppen = '<button class="obtn" onclick="window.__opvLb.afrondNietBereikbaar(\'' + s + '\')">&#128451; Rond af</button>' + knoppen;
    }
    knoppen = uitkomstKnop + knoppen;

    const nu = _ld.gesprek && _ld.gesprek.sleutel === s;
    return '<div class="row lb-rij' + (nu ? ' lb-nu' : '') + '"><div class="who">' +
      (r.waarom ? '<div class="lb-waarom">' + esc(r.waarom) + '</div>' : '') +
      '<div class="nm">' + esc(r.naam) +
      (r.product_label ? ' <span class="tag t-grey">' + esc(r.product_label) + '</span>' : '') +
      lijstTag(r) +
      (r.label ? ' <span class="tag ' + (LABEL_KLEUR[r.label.code] || 't-grey') + '">' + esc(r.label.tekst) + ' &middot; ' + esc(r.score) + '</span>' : '') +
      '</div>' +
      '<div class="lb-opener">' + esc(r.opener || '') + '</div>' +
      '<div class="mt">' + chips + (aangemeld ? '<span class="lb-zacht">' + esc(aangemeld) + '</span>' : '') + pil + '</div>' +
      extra + '</div><div class="act">' + knoppen + '</div></div>';
  }

  function afgerondTabel(items) {
    const grens = Date.now() - 30 * 86400000;
    const som = {};
    for (const r of items) {
      const a = r.kaart && r.kaart.archief;
      if (!a || Date.parse(r.kaart.gearchiveerd_at || '') < grens) continue;
      const c = a.categorie_tekst || 'zonder categorie';
      som[c] = (som[c] || 0) + 1;
    }
    let h = '<div class="lb-som">' + (Object.keys(som).length
      ? Object.entries(som).map(([c, n]) => '<span><b>' + esc(n) + '</b> ' + esc(c) + '</span>').join('')
      : '<span>Nog niets afgerond in de laatste 30 dagen.</span>') + '</div>';
    h += '<label class="lb-filter"><input type="checkbox" ' + (_ld.alleenWaarschuwing ? 'checked ' : '') +
      'onchange="window.__opvLb.filter(this.checked)"> alleen &#9888; weinig moeite</label>';
    const zicht = items.filter((r) => !_ld.alleenWaarschuwing || (r.kaart.archief && !r.kaart.archief.oordeel.genoeg));
    if (!zicht.length) return h + '<div class="agleeg">Niets te tonen.</div>';
    h += '<div class="lb-tabel"><table><thead><tr><th>Naam</th><th>Product</th><th>Categorie</th><th>Notitie</th>' +
      '<th>Inspanning</th><th>Dagen</th><th>Oordeel</th></tr></thead><tbody>';
    h += zicht.map((r) => {
      const k = r.kaart, a = k.archief || {};
      const ok = a.oordeel && a.oordeel.genoeg;
      return '<tr onclick="window.__opvLb.hist(\'' + sleutel(r) + '\')">' +
        '<td>' + esc(r.naam) + '</td><td>' + esc(r.product_label || '—') + '</td>' +
        '<td>' + esc(a.categorie_tekst || '—') + '</td><td class="nt">' + esc(a.reden || '') + '</td>' +
        '<td>&#9742; ' + esc(k.bel_totaal) + ' op ' + esc(k.bel_dagen) + ' d &middot; &#128172; ' + esc(k.wa_totaal) +
        ' &middot; ' + (k.contact ? 'gesproken' : 'nooit gesproken') + '</td>' +
        '<td>' + (a.dagen_tot_afronden == null ? '—' : esc(a.dagen_tot_afronden)) + '</td>' +
        '<td>' + (ok ? '&#9989; genoeg moeite' : '&#9888; weinig moeite') + '</td></tr>';
    }).join('');
    return h + '</tbody></table></div>';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // NU BELLEN — DE BELRIJ
  // ═════════════════════════════════════════════════════════════════════════
  // Tweeling van MAX_RONDES / BELRIJ_SECTIES in api/_lib/opvolging-leads-pot.js.
  const RONDES_MAX = 5;
  const SECTIES = [
    ['reageerde', 'Reageerde op je bericht', 'Stuurde iets terug na je laatste poging. Bel nu: hij is wakker.'],
    ['terugbellen', 'Afgesproken terugbellen', 'Vroeg zelf om vandaag gebeld te worden. Een belofte — eerst deze.'],
    ['verlopen', 'Agenda gekregen, niets ingepland', 'Toonde interesse maar koos binnen 48 uur geen moment.'],
    ['vers', 'Nieuw: vers of heet', 'Aangemeld in de laatste 2 dagen, of heet door zijn LMS-gebruik. Hoe sneller je belt, hoe hoger de kans.'],
    ['opnieuw', 'Volgende belronde', 'Nam eerder niet op; zijn volgende ronde is er. Eerste rondes eerst.'],
    ['nieuw', 'Overige nieuwe leads', 'Nog niet gebeld, warmste eerst. Als alles hierboven gedaan is.'],
    ['uitgebeld', 'Uitgebeld — rond af', RONDES_MAX + ' rondes zonder resultaat. Stuur een laatste WhatsApp of rond af.'],
  ];

  /** De belrij zonder wat Dave in deze belronde oversloeg. */
  function belrijItems(d) {
    const weg = _ld.ronde ? _ld.ronde.overgeslagen : null;
    return (d.items || []).filter((r) => !weg || !weg.has(sleutel(r)));
  }

  function belrijInhoud(d) {
    const items = belrijItems(d);
    const b = d.belrij || {};
    let h = '<div class="ronde">' + esc(POT_UITLEG.belrij) + '</div>';
    if (b.wacht_op_ronde) {
      h += '<div class="lb-weg">&#9203; ' + esc(b.wacht_op_ronde) + ' lead' + (b.wacht_op_ronde === 1 ? '' : 's') +
        ' wacht' + (b.wacht_op_ronde === 1 ? '' : 'en') + ' op hun volgende belronde' +
        (b.eerstvolgende_tekst ? ' &middot; eerstvolgende <b>' + esc(b.eerstvolgende_tekst) + '</b>' : '') +
        ' &middot; <a href="javascript:void(0)" onclick="window.__opvLb.kiesPot(\'bezig\')">bekijk In belronde</a></div>';
    }
    h += rondeBalk(items);
    if (!items.length) {
      return h + '<div class="agleeg">Niemand is nu aan de beurt. ' +
        (b.eerstvolgende_tekst ? 'De volgende ronde begint ' + esc(b.eerstvolgende_tekst) + '.' : '') + '</div>';
    }
    for (const [code, label, uitleg] of SECTIES) {
      const rijen = items.filter((r) => r.sectie === code);
      if (!rijen.length) continue;
      const alles = code !== 'nieuw' || _ld.toonAlles[code];
      const zicht = alles ? rijen : rijen.slice(0, NIEUW_ZICHTBAAR);
      h += '<div class="lb-sectie lb-s-' + code + '"><div class="lb-skop"><b>' + esc(label) + '</b> <span class="n">' + esc(rijen.length) +
        '</span><span class="lb-suitleg">' + esc(uitleg) + '</span></div>' +
        zicht.map((r) => leadRij(r, r.pot)).join('') +
        (zicht.length < rijen.length ? '<button class="obtn lb-meer" onclick="window.__opvLb.toonAlles(\'' + code + '\')">Toon alle ' + esc(rijen.length) + '</button>' : '') +
        '</div>';
    }
    return h;
  }

  /** De balk bovenaan in belronde-modus: wie is de volgende, met één klik bellen. */
  function rondeBalk(items) {
    const volgende = items[0] || null;
    if (!_ld.ronde) {
      return volgende ? '<div class="lb-rondestart"><button class="obtn p" onclick="window.__opvLb.startRonde()">&#9654; Start belronde</button>' +
        '<span>Belt de bovenste lead. Na elk gesprek vul je in hoe het ging, en staat de volgende klaar.</span></div>' : '';
    }
    const r = _ld.ronde;
    return '<div class="lb-rondebalk"><div><b>Belronde bezig</b> &middot; ' + esc(r.gebeld) + ' gebeld' +
      (volgende ? ' &middot; volgende: <b>' + esc(volgende.naam) + '</b> <span class="zacht">(' + esc(volgende.waarom || '') + ')</span>' : ' &middot; niemand meer aan de beurt') + '</div>' +
      '<div class="lb-rb-knoppen">' +
      (volgende ? '<button class="obtn p" onclick="window.__opvLb.bel(\'' + sleutel(volgende) + '\')">&#9742; Bel ' + esc(volgende.voornaam || volgende.naam) + '</button>' +
        '<button class="obtn" onclick="window.__opvLb.overslaan(\'' + sleutel(volgende) + '\')">Overslaan</button>' : '') +
      '<button class="obtn" onclick="window.__opvLb.stopRonde()">Stop</button></div></div>';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // APARTE LIJSTEN
  // ═════════════════════════════════════════════════════════════════════════
  // De rest van een lijst, onder 'Nu aan de beurt'. Codes = de potten.
  const LIJST_REST = [
    ['terugbellen', 'Terugbelafspraken', 'Afgesproken dag nog niet bereikt. Op die dag staat hij hierboven.'],
    ['verlopen', 'Termijn verlopen', 'Agenda gekregen, niets ingepland; wacht op de volgende ronde.'],
    ['bezig', 'In belronde', 'Al geprobeerd; komt terug op het moment van zijn volgende ronde.'],
    ['wacht', 'Wacht op inplanning', 'Agenda doorgestuurd; ze kiezen zelf. Na 48 uur zonder afspraak komen ze terug.'],
    ['later', 'Komt later', 'Staat op een latere dag.'],
    ['ingepland', 'Ingepland', 'Gelukt.'],
    ['afgerond', 'Afgerond', 'Weggegooid, met de moeite die ervoor gedaan is.'],
  ];

  /** De chips van de actieve aparte lijsten, achter de potten. */
  function lijstChips(a, pot) {
    if (!a) return '';
    const heeft = (a.actief || []).length || (a.archief || []).length;
    let h = heeft ? '<span class="lb-sep"></span>' : '';
    h += (a.actief || []).map((l) => {
      const code = 'lijst:' + l.id;
      const t = l.telling || {};
      return '<button class="lb-pot lb-lijst' + (code === pot ? ' on' : '') + '" title="Aparte lijst &middot; ' +
        esc(t.open || 0) + ' open &middot; ' + esc(t.afgewerkt || 0) + ' afgewerkt" onclick="window.__opvLb.kiesPot(\'' + esc(code) + '\')">' +
        '&#128203; ' + esc(l.naam) + '<span class="n">' + esc(t.open || 0) + '</span>' +
        (t.afgewerkt ? '<span class="af">&#10003;&nbsp;' + esc(t.afgewerkt) + '</span>' : '') + '</button>';
    }).join('');
    if ((a.archief || []).length) {
      h += '<button class="lb-pot lb-arch' + (_ld.archiefOpen ? ' on' : '') + '" onclick="window.__opvLb.archief()" title="Gearchiveerde aparte lijsten">' +
        '&#128451; Gearchiveerd<span class="n">' + esc(a.archief.length) + '</span></button>';
    }
    return h;
  }

  /** De gearchiveerde lijsten: de historiek blijft, klik = bekijken. */
  function archiefBlok(a) {
    const lijst = (a && a.archief) || [];
    if (!lijst.length) return '';
    return '<div class="lb-archief"><b>Gearchiveerde lijsten</b>' + lijst.map((l) => {
      const t = l.telling || {};
      return '<button class="obtn" onclick="window.__opvLb.kiesPot(\'lijst:' + esc(l.id) + '\')">&#128203; ' + esc(l.naam) +
        ' <span class="zacht">&middot; ' + esc(t.afgewerkt || 0) + '/' + esc(t.totaal || 0) + ' afgewerkt' +
        (l.gearchiveerd_at ? ' &middot; gearchiveerd ' + esc(datumNl(String(l.gearchiveerd_at).slice(0, 10))) : '') + '</span></button>';
    }).join('') + '</div>';
  }

  function lijstInhoud(d) {
    const l = d.lijst || {};
    const t = l.telling || {};
    const gearch = l.status === 'gearchiveerd';
    const b = d.lijst_belrij || {};
    let h = '<div class="lb-lijstkop"><div><div class="nm">&#128203; ' + esc(l.naam) + ' <span class="tag t-teal">aparte lijst</span>' +
      (gearch ? ' <span class="tag t-amber">gearchiveerd' + (l.gearchiveerd_at ? ' op ' + esc(datumNl(String(l.gearchiveerd_at).slice(0, 10))) : '') + '</span>' : '') + '</div>' +
      '<div class="lb-som"><span><b>' + esc(t.open || 0) + '</b> open</span><span><b>' + esc(l.nu || 0) + '</b> nu aan de beurt</span>' +
      '<span><b>' + esc(t.ingepland || 0) + '</b> ingepland</span><span><b>' + esc(t.afgerond || 0) + '</b> afgerond</span>' +
      '<span class="zacht">' + esc(t.totaal || 0) + ' in totaal</span></div></div>' +
      (gearch
        ? '<button class="obtn p" ' + (_ld.bezig ? 'disabled ' : '') + 'onclick="window.__opvLb.lijstTerug(\'' + esc(l.id) + '\')">&#8634; Terugzetten</button>'
        : '<button class="obtn" ' + (_ld.bezig ? 'disabled ' : '') + 'onclick="window.__opvLb.lijstArchiveer(\'' + esc(l.id) + '\')">&#128451; Archiveer lijst</button>') +
      '</div>';
    h += '<div class="ronde">Deze leads staan alleen in deze lijst, niet in Nu bellen of de andere potten. ' +
      'Terugbelafspraken en de belrondes werken zoals altijd, binnen de lijst. Werk van boven naar onder.</div>';

    const items = belrijItems(d);
    h += '<div class="lb-lh">Nu aan de beurt <span class="n">' + esc(items.length) + '</span></div>';
    if (b.wacht_op_ronde) {
      h += '<div class="lb-weg">&#9203; ' + esc(b.wacht_op_ronde) + ' wacht' + (b.wacht_op_ronde === 1 ? '' : 'en') + ' op hun volgende belronde' +
        (b.eerstvolgende_tekst ? ' &middot; eerstvolgende <b>' + esc(b.eerstvolgende_tekst) + '</b>' : '') + '</div>';
    }
    if (!gearch) h += rondeBalk(items);
    if (!items.length) h += '<div class="agleeg">Niemand uit deze lijst is nu aan de beurt.</div>';
    for (const [code, label, uitleg] of SECTIES) {
      const rijen = items.filter((r) => r.sectie === code);
      if (!rijen.length) continue;
      h += '<div class="lb-sectie lb-s-' + code + '"><div class="lb-skop"><b>' + esc(label) + '</b> <span class="n">' + esc(rijen.length) +
        '</span><span class="lb-suitleg">' + esc(uitleg) + '</span></div>' + rijen.map((r) => leadRij(r, r.pot)).join('') + '</div>';
    }

    const sec = d.secties || {};
    for (const [code, label, uitleg] of LIJST_REST) {
      const rijen = sec[code] || [];
      if (!rijen.length) continue;
      h += '<div class="lb-sectie lb-r-' + code + '"><div class="lb-skop"><b>' + esc(label) + '</b> <span class="n">' + esc(rijen.length) +
        '</span><span class="lb-suitleg">' + esc(uitleg) + '</span></div>' +
        (code === 'afgerond' ? afgerondTabel(rijen) : rijen.map((r) => leadRij(r, code)).join('')) + '</div>';
    }
    return h;
  }

  function uitlegBlok() {
    return '<div class="lb-uitleg">' +
      '<h4>Hoe werkt Leads bellen?</h4>' +
      '<ol>' +
      '<li><b>Start altijd in &ldquo;Nu bellen&rdquo;</b> en werk van boven naar onder. De volgorde is de prioriteit: ' +
      'wie reageerde &rarr; afgesproken terugbellen &rarr; agenda gekregen maar niets ingepland &rarr; verse en hete nieuwe leads &rarr; de volgende belronde &rarr; de rest van Nieuw.</li>' +
      '<li><b>Na elke call</b> vraagt het scherm hoe het ging: <i>geen gehoor</i>, <i>voicemail</i>, <i>gesproken</i> of <i>foutief nummer</i>. ' +
      'Gesproken? Dan kies je meteen: inplannen, agenda sturen, terugbellen op een dag die hij zelf noemt, of afronden.</li>' +
      '<li><b>Geen gehoor schuift vanzelf door.</b> Een lead die je net probeerde, verdwijnt uit Nu bellen tot zijn volgende ronde: ' +
      'ronde 2 drie uur later (ander moment van de dag), ronde 3 de volgende ochtend, ronde 4 twee dagen later, ronde 5 drie dagen later. ' +
      'Twee keer kort na elkaar bellen is één ronde. Na ' + RONDES_MAX + ' rondes staat hij bij <i>Uitgebeld</i>: laatste WhatsApp of afronden.</li>' +
      '<li><b>Stuur na de eerste keer geen gehoor een WhatsApp</b> (het scherm stelt de tekst voor). Antwoordt hij, dan springt hij bovenaan in Nu bellen.</li>' +
      '<li><b>&ldquo;Moet later terugkomen&rdquo;</b> zet hem in Terugbelafspraken met de datum. Op die dag staat hij bovenaan in Nu bellen.</li>' +
      '<li><b>Agenda doorsturen</b> zet hem 48 uur in <i>Wacht op inplanning</i>. Kiest hij geen moment, dan komt hij terug als <i>Agenda gekregen, niets ingepland</i>.</li>' +
      '<li>Onderaan staat het <b>logboek</b>: elke call, elk bericht en elke beslissing per dag.</li>' +
      '</ol></div>';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // LOGBOEK
  // ═════════════════════════════════════════════════════════════════════════
  function logboekBlok() {
    const st = _ld.logboek;
    if (!st.data && !st.laden && !st.fout) straks(laadLogboek);
    let h = '<div class="lb-logboek"><div class="lb-logkop"><h4>Logboek</h4>' +
      '<div class="lb-dagnav"><button class="obtn" onclick="window.__opvLb.logDag(-1)">&lsaquo;</button>' +
      '<span>' + esc(st.data ? langeDag(st.data.dag, st.data.vandaag) : (st.dag ? langeDag(st.dag) : 'vandaag')) + '</span>' +
      '<button class="obtn" ' + (st.data && st.data.dag >= st.data.vandaag ? 'disabled ' : '') + 'onclick="window.__opvLb.logDag(1)">&rsaquo;</button></div></div>';
    if (st.fout) return h + '<div class="warn">' + esc(st.fout) + '</div></div>';
    if (!st.data) return h + '<div class="agleeg">Laden&hellip;</div></div>';
    const d = st.data, v = d.kpi;
    const cel = (n, l) => '<div class="lb-cel"><b>' + esc(n) + '</b><span>' + esc(l) + '</span></div>';
    h += '<div class="lb-strip lb-strip8">' +
      cel(v.pogingen, 'belpogingen') + cel(v.leads_gebeld, 'leads gebeld') + cel(v.opgenomen, 'opgenomen') +
      cel(v.geen_gehoor + v.voicemail, 'geen gehoor / voicemail') + cel(v.wa_uit, 'WhatsApp uit') + cel(v.wa_in, 'WhatsApp in') +
      cel(v.ingepland, 'ingepland') + cel(v.doorgestuurd, 'agenda gestuurd') + cel(v.terugbel, 'terugbelafspraken') +
      cel(v.afgerond, 'afgerond') + cel(v.nieuw_aangeraakt, 'nieuwe leads aangeraakt') + cel(minuten(v.belseconden), 'aan de lijn') + '</div>';
    for (const m of d.meldingen || []) h += '<div class="warn2">' + esc(m) + '</div>';
    h += '<div class="lb-logtabs"><button class="lb-pot' + (_ld.logTab === 'tijdlijn' ? ' on' : '') + '" onclick="window.__opvLb.logTab(\'tijdlijn\')">Alle gebeurtenissen <span class="n">' + esc(d.rijen.length) + '</span></button>' +
      '<button class="lb-pot' + (_ld.logTab === 'leads' ? ' on' : '') + '" onclick="window.__opvLb.logTab(\'leads\')">Per lead <span class="n">' + esc(d.per_lead.length) + '</span></button></div>';
    if (_ld.logTab === 'leads') {
      if (!d.per_lead.length) return h + '<div class="agleeg">Op deze dag is er niets met leads gebeurd.</div></div>';
      return h + '<div class="lb-tabel"><table><thead><tr><th>Lead</th><th>Calls</th><th>Opgenomen</th><th>Laatste</th></tr></thead><tbody>' +
        d.per_lead.map((r) => '<tr onclick="window.__opvHist(\'' + esc(r.taak_id) + '\')"><td>' + esc(r.naam) + '</td><td>' + esc(r.calls) +
          '</td><td>' + esc(r.opgenomen) + '</td><td>' + esc(r.laatste) + '</td></tr>').join('') + '</tbody></table></div></div>';
    }
    if (!d.rijen.length) return h + '<div class="agleeg">Op deze dag is er niets met leads gebeurd.</div></div>';
    h += '<div class="lb-tijdlijn">' + d.rijen.map((r) =>
      '<div class="lb-tl lb-tl-' + esc(r.soort) + '"><span class="t">' + esc(r.tijd) + '</span><span class="i">' + esc(r.icoon) + '</span>' +
      '<span class="w"><b>' + esc(r.naam) + '</b> &middot; ' + esc(r.tekst) +
      (r.duur_sec != null ? ' <span class="zacht">(' + esc(r.duur_sec) + ' s)</span>' : '') +
      (r.zelf_gemeld ? ' <span class="zacht">&middot; zelf gemeld</span>' : '') + '</span></div>').join('') + '</div>';
    return h + '</div>';
  }

  function minuten(sec) {
    const n = Number(sec) || 0;
    if (n < 60) return n + ' s';
    return Math.floor(n / 60) + ' min ' + String(n % 60).padStart(2, '0');
  }
  function datumNl(dag) {
    try {
      return new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
        .format(new Date(String(dag).slice(0, 10) + 'T12:00:00Z')).replace(/\./g, '');
    } catch (_) { return String(dag || ''); }
  }
  function langeDag(dag, vandaag) {
    if (vandaag && dag === vandaag) return 'Vandaag';
    try {
      return new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
        .format(new Date(String(dag).slice(0, 10) + 'T12:00:00Z'));
    } catch (_) { return String(dag || ''); }
  }
  /** 'nu', 'vandaag 15:30', 'morgen 09:00', 'do 16 okt 09:00'. Met verleden=true: 'vandaag 10:12', 'gisteren …'. */
  function momentKort(iso, verleden) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    if (!verleden && t <= Date.now()) return 'nu';
    const f = (o) => new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', ...o }).format(new Date(t));
    const dagVan = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date(ms));
    const uur = f({ hour: '2-digit', minute: '2-digit' });
    const verschil = Math.round((Date.parse(dagVan(t) + 'T12:00:00Z') - Date.parse(dagVan(Date.now()) + 'T12:00:00Z')) / 86400000);
    if (verschil === 0) return 'vandaag ' + uur;
    if (verschil === 1) return 'morgen ' + uur;
    if (verschil === -1) return 'gisteren ' + uur;
    return f({ weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '') + ' ' + uur;
  }

  // ── Beheer: agendalink & berichten (manager / super_admin) ───────────────
  function beheerBlok() {
    const st = _ld.inst;
    if (!st.data && !st.laden && !st.fout) straks(laadInst);
    if (!st.data || !st.data.mag_bewerken) return '';
    const i = st.data.instelling || {};
    return '<div class="lb-beheer"><h4>Agendalink &amp; berichten</h4>' +
      '<div class="ronde">Gebruikt door <b>Agenda doorsturen</b> (daglijst én Leads bellen). Zonder link wordt er niets verstuurd. ' +
      '<code>{voornaam}</code> en <code>{link}</code> worden ingevuld; <code>{link}</code> moet in elke tekst staan.</div>' +
      (i.agenda_link ? '' : '<div class="warn"><b>Agendalink nog niet ingesteld</b> &mdash; de knoppen versturen niets tot hij hier staat.</div>') +
      kanaalVelden(st.data, i) +
      '<label>Agendalink (https://…)</label><input id="lb-link" type="url" value="' + esc(i.agenda_link || '') + '" placeholder="https://">' +
      '<div class="ronde zacht">De twee teksten hieronder gelden alleen voor het brug-kanaal (en als terugval zolang de templates niet goedgekeurd zijn). ' +
      'De Meta-templates hebben hun eigen, door Meta goedgekeurde tekst.</div>' +
      '<label>Bericht bij doorsturen</label><textarea id="lb-bericht" rows="6">' + esc(i.bericht || '') + '</textarea>' +
      '<label>Herinnering</label><textarea id="lb-herinnering" rows="4">' + esc(i.herinnering || '') + '</textarea>' +
      (st.melding ? '<div class="' + (st.melding.ok ? 'ronde' : 'warn') + '">' + esc(st.melding.tekst) + '</div>' : '') +
      '<button class="obtn p" ' + (st.bezig ? 'disabled' : '') + ' onclick="window.__opvLb.bewaarInst()">' + (st.bezig ? 'Bewaren&hellip;' : 'Bewaren') + '</button></div>';
  }

  /** Kanaal (Meta-template of brug), de Meta-lijn en de stand van de templates. */
  function kanaalVelden(d, i) {
    const lijnen = (d && d.lijnen) || [];
    const t = (d && d.templates) || {};
    const tStand = (x) => !x ? '—' : x.goedgekeurd ? '&#9989; goedgekeurd' : esc(String(x.status || '').toLowerCase() === 'ontbreekt' ? 'nog niet ingediend' : 'status ' + x.status);
    const huidigeModule = i.module || 'leadsonderhoud';
    const opties = lijnen.length
      ? lijnen.map((l) => '<option value="' + esc(l.module) + '"' + (l.module === huidigeModule ? ' selected' : '') + '>' +
          esc(l.label) + ' (' + esc(l.module) + ')</option>').join('')
      : '<option value="' + esc(huidigeModule) + '" selected>' + esc(huidigeModule) + '</option>';
    return '<label>Kanaal</label><select id="lb-kanaal">' +
      '<option value="meta"' + (i.kanaal !== 'brug' ? ' selected' : '') + '>Meta-template (aanbevolen)</option>' +
      '<option value="brug"' + (i.kanaal === 'brug' ? ' selected' : '') + '>WhatsApp-lijn van het CRM (brug, vrije tekst)</option></select>' +
      '<label>Meta-lijn (standaard: de lijn van de afspraakberichten)</label><select id="lb-module">' + opties + '</select>' +
      '<div class="ronde zacht">Templates: <b>' + esc((t.eerste && t.eerste.naam) || 'agenda_doorsturen_v1') + '</b> ' + tStand(t.eerste) +
      ' &middot; <b>' + esc((t.herinnering && t.herinnering.naam) || 'agenda_herinnering_v1') + '</b> ' + tStand(t.herinnering) +
      (d && d.lijn_actief ? '' : ' &middot; <span style="color:var(--o-red)">geen actieve Meta-lijn gevonden</span>') +
      '. Zolang een template niet goedgekeurd is, gaat het via de brug.' +
      (d && d.meta_fout ? ' <span style="color:var(--o-red)">(' + esc(d.meta_fout) + ')</span>' : '') + '</div>';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DE VENSTERS VAN DEZE TAB
  // ═════════════════════════════════════════════════════════════════════════
  const opt = (em, bg, titel, sub, actie) =>
    '<button class="opt" onclick="' + actie + '"><div class="em" style="background:' + bg + '">' + em + '</div>' +
    '<div><b>' + titel + '</b><span>' + sub + '</span></div></button>';

  function venster(titel, sub, body) {
    return '<div class="opv"><div class="scrim on"><div class="modal">' +
      '<div class="mh"><div><h3>' + titel + '</h3><p>' + sub + '</p></div>' +
      '<button class="x" onclick="window.__opvLb.sluit()">&times;</button></div>' +
      '<div class="mb">' + body + '</div></div></div></div>';
  }

  const dagPlus = (n) => {
    const d = new Date(); d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const volgendeMaandag = () => { const d = new Date(); const n = ((8 - d.getDay()) % 7) || 7; return dagPlus(n); };

  function leadsModalHtml() {
    const m = _ld.modal;
    if (!m) return '';
    if (m.soort === 'import') return importVenster(m);
    const r = _ld.rijen.get(m.sleutel);
    if (!r) return '';
    const k = r.kaart || {};
    const s = m.sleutel;
    if (m.soort === 'uitkomst') {
      const body =
        (r.opener ? '<div class="ronde">' + esc(r.opener) + '</div>' : '') +
        opt('&#128245;', 'var(--o-ambs)', 'Geen gehoor', 'Ging over, niemand nam op. Hij schuift door naar zijn volgende belronde.', "window.__opvLb.kiesUitkomst('" + s + "','geen_gehoor')") +
        opt('&#128252;', 'var(--o-ambs)', 'Voicemail', 'Kreeg de voicemail (ingesproken of niet). Telt als geen gehoor, niet als gesprek.', "window.__opvLb.kiesUitkomst('" + s + "','voicemail')") +
        opt('&#128172;', 'var(--o-grns)', 'Gesproken', 'Je had hem aan de lijn. Kies daarna meteen de volgende stap.', "window.__opvLb.kiesUitkomst('" + s + "','gesproken')") +
        opt('&#10006;', 'var(--o-reds)', 'Foutief nummer', 'Verkeerde persoon of nummer bestaat niet. Rondt de lead meteen af.', "window.__opvLb.kiesUitkomst('" + s + "','foutief_nummer')") +
        (m.fout ? '<div class="warn">' + esc(m.fout) + '</div>' : '');
      return venster('Hoe ging de call met ' + esc(r.naam) + '?',
        k.plan ? 'Ronde ' + esc((k.plan.rondes || 0)) + ' van ' + RONDES_MAX + ' &middot; ' + esc(k.bel_totaal || 0) + '&times; gebeld' : 'Vul in wat er gebeurde', body);
    }
    if (m.soort === 'na') {
      const p = m.plan || k.plan || null;
      const geenWa = !(Number(k.wa_totaal) > 0);
      const volgende = _ld.ronde ? belrijItems(huidigeBelrij())[0] : null;
      const body =
        '<div class="ronde">' + (m.uitkomst === 'voicemail' ? '&#128252; Voicemail genoteerd.' : '&#128245; Geen gehoor genoteerd.') + ' ' +
        (p ? (p.uitgebeld ? 'Dit was ronde ' + esc(p.rondes) + ': <b>uitgebeld</b>. Stuur een laatste bericht of rond af.'
          : 'Volgende ronde: <b>' + esc(momentKort(p.volgende_at)) + '</b>. Tot dan staat hij niet in Nu bellen.') : 'De volgende ronde wordt berekend&hellip;') + '</div>' +
        (geenWa ? opt('&#9993;', 'var(--o-grns)', 'Stuur nu een WhatsApp', 'Na geen gehoor verhoogt een kort bericht de kans dat hij terugbelt of reageert. De tekst staat klaar; je past hem aan waar je wil.', "window.__opvLb.waNaCall('" + s + "')") : '') +
        opt('&#8635;', 'var(--o-purs)', 'Zelf een moment kiezen', 'Hij is pas bereikbaar na 18u, of je wil het morgenvroeg nog eens proberen.', "window.__opvLb.open('opnieuw','" + s + "')") +
        (volgende ? '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvLb.bel(\'' + sleutel(volgende) + '\')">&#9742; Volgende: ' + esc(volgende.naam) + '</button>'
          : '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvLb.sluit()">Klaar</button>');
      return venster(esc(r.naam), 'Genoteerd', body);
    }
    if (m.soort === 'opnieuw') {
      const knop = (l, w) => '<button class="obtn" onclick="window.__opvLb.opnieuwOm(\'' + s + '\',\'' + w + '\')">' + esc(l) + '</button>';
      const body = '<div class="ronde">Kies wanneer hij weer in Nu bellen mag verschijnen. Gaat het om een afspraak mét de lead, gebruik dan &ldquo;Moet later terugkomen&rdquo;.</div>' +
        '<div class="lb-snel">' + knop('over 1 uur', 'u1') + knop('over 3 uur', 'u3') + knop('vanavond 18:00', 'vanavond') + knop('morgenochtend', 'morgen') + '</div>' +
        (m.fout ? '<div class="warn">' + esc(m.fout) + '</div>' : '');
      return venster('Opnieuw proberen: ' + esc(r.naam), 'Een eigen moment voor de volgende poging', body);
    }
    if (m.soort === 'watnu') {
      const verlopen = k.reden_code === 'inplantermijn_verlopen';
      const body =
        (m.naGesprek ? '<div class="ronde">&#128172; <b>Gesproken</b> genoteerd. Wat spraken jullie af?</div>' : '') +
        (r.opener ? '<div class="ronde">' + esc(r.opener) + '</div>' : '') +
        opt('&#128197;', 'var(--o-grns)', 'Inplannen via Zoom', 'Kies samen een moment terwijl je hem aan de lijn hebt. Daarmee is de kaart klaar.', "window.__opvLb.inplannen('" + s + "')") +
        opt('&#128233;', 'var(--o-accs)', verlopen ? 'Agenda opnieuw doorsturen' : 'Agenda doorsturen',
          'Verstuurt nu de agendalink via WhatsApp. Plant hij niets in binnen 48 uur, dan komt hij terug.', "window.__opvLb.doorsturen('" + s + "')") +
        opt('&#9200;', 'var(--o-purs)', 'Moet later terugkomen', 'Hij noemde zelf een later moment. Schrijf op wat hij zei.', "window.__opvLb.open('terug','" + s + "')") +
        opt('&#8635;', 'var(--o-ambs)', 'Opnieuw proberen', 'Kon niet praten of geen tijd. Kies wanneer hij weer in Nu bellen komt (over 1u, 3u, vanavond, morgen).', "window.__opvLb.open('opnieuw','" + s + "')") +
        opt('&#128451;', 'var(--o-reds)', 'Afronden', 'Weggooien, met reden. Maxim ziet de moeite die gedaan is.', "window.__opvLb.open('afronden','" + s + "')");
      return venster('Wat nu met ' + esc(r.naam) + '?',
        esc(k.bel_totaal || 0) + '&times; gebeld op ' + esc(k.bel_dagen || 0) + ' d &middot; ' + esc(k.wa_totaal || 0) + '&times; WhatsApp', body);
    }
    if (m.soort === 'terug') {
      const snel = [['morgen', dagPlus(1)], ['over 2 dagen', dagPlus(2)], ['over 4 dagen', dagPlus(4)], ['volgende week', volgendeMaandag()]];
      const body =
        '<div class="lb-snel">' + snel.map(([l, d]) =>
          '<button class="obtn' + (m.due === d ? ' p' : '') + '" onclick="window.__opvLb.kiesDag(\'' + d + '\')">' + esc(l) + '</button>').join('') + '</div>' +
        '<input type="date" id="lb-dt" min="' + dagPlus(1) + '" value="' + esc(m.due || dagPlus(2)) + '" onchange="window.__opvLb.kiesDag(this.value, true)">' +
        '<label class="lb-l">Wat zei de lead? (verplicht)</label>' +
        '<textarea id="lb-noot" rows="3" oninput="window.__opvLb.typ(this.value)" placeholder="bv. zit nu op het werk, bel donderdag na 18u">' + esc(m.noot || '') + '</textarea>' +
        (m.fout ? '<div class="warn">' + esc(m.fout) + '</div>' : '') +
        '<button class="obtn p" style="width:100%;margin-top:12px" ' + (_ld.bezig ? 'disabled' : '') + ' onclick="window.__opvLb.bewaarTerug()">Zet hem op die dag</button>';
      return venster('Wanneer komt ' + esc(r.naam) + ' terug?', 'Op die dag staat hij bovenaan in Terugbellen.', body);
    }
    if (m.soort === 'afronden') {
      const oordeel = beoordeel(k, m.categorie);
      const body =
        '<div class="ronde"><b>Inspanning:</b> ' + esc(inspanning(k)) + '</div>' +
        '<label class="lb-l">Waarom? (verplicht)</label><div class="lb-cats">' + CATEGORIEEN.map(([c, l]) =>
          '<button class="obtn' + (m.categorie === c ? ' p' : '') + '" onclick="window.__opvLb.kiesCat(\'' + c + '\')">' + esc(l) + '</button>').join('') + '</div>' +
        '<label class="lb-l">Uitleg (minstens ' + AFROND_MIN_NOTITIE + ' tekens)</label>' +
        '<textarea id="lb-noot" rows="3" oninput="window.__opvLb.typ(this.value)" placeholder="bv. 3x gebeld, 1 WhatsApp, zegt dat hij geen tijd heeft">' + esc(m.noot || '') + '</textarea>' +
        (m.categorie && !oordeel.genoeg ? '<div class="warn"><b>Even checken &mdash; weinig moeite gedaan.</b> Nog: ' + esc(oordeel.tekort.join(', ')) +
          '. De afspraak is minstens ' + AFROND_MIN_BEL + ' belpogingen op ' + AFROND_MIN_BEL_DAGEN + ' verschillende dagen én ' + AFROND_MIN_WA + ' WhatsApp.</div>' : '') +
        (m.fout ? '<div class="warn">' + esc(m.fout) + '</div>' : '') +
        '<button class="obtn p" style="width:100%;margin-top:12px;' + (m.categorie && !oordeel.genoeg ? 'background:var(--o-amb);border-color:var(--o-amb)' : '') + '" ' +
        (_ld.bezig ? 'disabled' : '') + ' onclick="window.__opvLb.bewaarAfronden()">' +
        (m.categorie && !oordeel.genoeg ? 'Toch afronden' : 'Afronden') + '</button>';
      return venster(esc(r.naam) + ' afronden', 'Hij komt niet terug in Leads bellen.', body);
    }
    return '';
  }

  // ── Lijst opladen ────────────────────────────────────────────────────────
  // CSV met naam, telefoon, email (opt.), notitie (opt.) + één label voor de
  // hele lijst. Eerst een voorvertoning (er wordt niets geschreven), dan
  // bevestigen. Gedoseerd: max N per werkdag (standaard 10).
  // Of: een NIEUWE APARTE LIJST met een eigen chip, zonder dosering.
  function importVenster(m) {
    const vv = m.vv;
    const apart = m.modus === 'aparte_lijst';
    const keuze = (waarde, titel, sub) =>
      '<label class="lb-keuze' + ((m.modus || 'pot') === waarde ? ' on' : '') + '"><input type="radio" name="lb-imp-modus" value="' + waarde + '"' +
      ((m.modus || 'pot') === waarde ? ' checked' : '') + ' onchange="window.__opvLb.impModus(\'' + waarde + '\')">' +
      '<span><b>' + titel + '</b><span>' + sub + '</span></span></label>';
    let body =
      '<div class="ronde">Kopregel met <code>naam</code> en <code>telefoon</code> (verplicht), <code>email</code> en <code>notitie</code> (mag). ' +
      'Scheiding met ; of ,. Plak de lijst of kies een bestand.</div>' +
      '<label class="lb-l">Waar komen ze terecht?</label><div class="lb-keuzes">' +
      keuze('pot', 'Toevoegen aan algemene pot (zoals nu)', 'Gedoseerd: ze komen op hun dag vanzelf in Nu bellen.') +
      keuze('aparte_lijst', 'Nieuwe aparte lijst', 'Eigen chip bovenaan, alles meteen zichtbaar. Telt niet mee in Nu bellen of de andere potten.') +
      '</div>' +
      (apart
        ? '<label class="lb-l">Naam van de lijst (verplicht)</label>' +
          '<input id="lb-imp-naam" maxlength="60" placeholder="bv. Webinar september" value="' + esc(m.lijstNaam || '') + '" oninput="window.__opvLb.impVeld(\'lijstNaam\', this.value)">'
        : '<label class="lb-l">Label voor deze lijst (verplicht)</label>' +
          '<input id="lb-imp-label" maxlength="60" placeholder="bv. Geannuleerd voorjaar" value="' + esc(m.label || '') + '" oninput="window.__opvLb.impVeld(\'label\', this.value)">' +
          '<label class="lb-l">Maximaal per werkdag</label>' +
          '<input id="lb-imp-dag" type="number" min="1" max="100" value="' + esc(m.perDag || 10) + '" oninput="window.__opvLb.impVeld(\'perDag\', this.value)">') +
      '<label class="lb-l">CSV</label>' +
      '<input type="file" accept=".csv,text/csv,text/plain" onchange="window.__opvLb.impBestand(this)">' +
      '<textarea id="lb-imp-csv" rows="6" style="margin-top:6px" oninput="window.__opvLb.impVeld(\'csv\', this.value)" placeholder="naam;telefoon;email;notitie">' + esc(m.csv || '') + '</textarea>';
    if (m.fout) body += '<div class="warn">' + esc(m.fout) + '</div>';
    if (m.klaar) body += '<div class="ronde"><b>&#10003; ' + esc(m.klaar) + '</b></div>';
    // Aparte lijst: nieuw / verhuisd uit de pot / overgeslagen (met reden).
    const vvApart = !!(vv && apart && vv.aantallen && vv.aantallen.verhuis != null);
    if (vvApart) {
      const a = vv.aantallen;
      const STATUS = { geldig: '&#10003; nieuw', verhuis: '&#8618; verhuisd uit de pot' };
      body += '<div class="lb-som"><span><b>' + esc(a.geldig) + '</b> nieuw</span><span><b>' + esc(a.verhuis) +
        '</b> verhuisd uit de pot</span><span><b>' + esc(a.overgeslagen) + '</b> overgeslagen</span></div>' +
        ((vv.overgeslagen_redenen || []).length ? '<div class="lb-weg">Overgeslagen: ' + vv.overgeslagen_redenen.map((x) =>
          esc(x.aantal) + ' ' + esc(x.tekst)).join(' &middot; ') + '</div>' : '') +
        (a.verhuis ? '<div class="ronde">Verhuizen = dezelfde kaart met zijn historiek, pogingen en terugbelafspraak; hij verdwijnt uit Nu bellen en staat voortaan in deze lijst.</div>' : '') +
        '<div class="ronde">' + esc(vv.samenvatting) + '.</div>' +
        '<div class="lb-tabel" style="max-height:240px;overflow:auto"><table><thead><tr><th>Regel</th><th>Naam</th><th>Telefoon</th><th>Wat gebeurt er</th></tr></thead><tbody>' +
        vv.rijen.slice(0, 200).map((r) => '<tr><td>' + esc(r.regel) + '</td><td>' + esc(r.naam) + '</td><td>' + esc(r.telefoon || r.telefoon_ruw) +
          '</td><td>' + (STATUS[r.status] || esc('overgeslagen' + (r.reden ? ' — ' + r.reden : ''))) +
          (r.status === 'verhuis' && r.kaart && r.kaart.badge_label ? ' <span class="zacht">(' + esc(r.kaart.badge_label) + ')</span>' : '') +
          '</td></tr>').join('') +
        '</tbody></table></div>';
    } else if (vv) {
      body += '<div class="lb-som"><span><b>' + esc(vv.aantallen.geldig) + '</b> geldig</span><span><b>' + esc(vv.aantallen.dubbel) +
        '</b> dubbel</span><span><b>' + esc(vv.aantallen.ongeldig) + '</b> ongeldig nummer of naam</span></div>' +
        '<div class="ronde">' + esc(vv.samenvatting) + (vv.dosering === false || vv.per_dag == null ? '' : ' (max ' + esc(vv.per_dag) + ' per werkdag)') + '.</div>' +
        '<div class="lb-tabel" style="max-height:240px;overflow:auto"><table><thead><tr><th>Regel</th><th>Naam</th><th>Telefoon</th><th>Status</th><th>Dag</th></tr></thead><tbody>' +
        vv.rijen.slice(0, 200).map((r) => '<tr><td>' + esc(r.regel) + '</td><td>' + esc(r.naam) + '</td><td>' + esc(r.telefoon || r.telefoon_ruw) +
          '</td><td>' + (r.status === 'geldig' ? '&#10003; geldig' : esc(r.status + (r.reden ? ' — ' + r.reden : ''))) + '</td><td>' + esc(r.due || '') + '</td></tr>').join('') +
        '</tbody></table></div>';
    }
    const kan = !_ld.bezig;
    const nApart = vvApart ? (Number(vv.aantallen.geldig) || 0) + (Number(vv.aantallen.verhuis) || 0) : 0;
    body += '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="obtn" ' + (kan ? '' : 'disabled ') + 'onclick="window.__opvLb.impVoor()">Voorvertoning</button>' +
      (vvApart && nApart && !m.klaar ? '<button class="obtn p" ' + (kan ? '' : 'disabled ') + 'onclick="window.__opvLb.impBevestig()">Bevestigen: lijst &ldquo;' +
        esc(String(m.lijstNaam || '').trim()) + '&rdquo; met ' +
        [vv.aantallen.geldig ? esc(vv.aantallen.geldig) + ' nieuw' : '', vv.aantallen.verhuis ? esc(vv.aantallen.verhuis) + ' verhuisd' : ''].filter(Boolean).join(' + ') +
        '</button>' : '') +
      (!vvApart && vv && vv.aantallen.geldig && !m.klaar ? '<button class="obtn p" ' + (kan ? '' : 'disabled ') + 'onclick="window.__opvLb.impBevestig()">Bevestigen: ' +
        esc(vv.aantallen.geldig) + ' kaart' + (vv.aantallen.geldig === 1 ? '' : 'en') + ' maken</button>' : '') + '</div>';
    return venster('Lijst opladen', apart ? 'Een nieuwe aparte lijst in Leads bellen, met eigen chip.' : 'Oude leads in Leads bellen, gedoseerd.', body);
  }

  async function impPost(bevestig) {
    const m = _ld.modal; if (!m || m.soort !== 'import' || _ld.bezig) return;
    const apart = m.modus === 'aparte_lijst';
    if (apart && !String(m.lijstNaam || '').trim()) { m.fout = 'Geef de aparte lijst een naam.'; teken(); return; }
    if (!apart && !String(m.label || '').trim()) { m.fout = 'Geef de lijst een label.'; teken(); return; }
    if (!String(m.csv || '').trim()) { m.fout = 'Plak een lijst of kies een bestand.'; teken(); return; }
    _ld.bezig = true; m.fout = null; teken();
    try {
      const body = apart
        ? { csv: m.csv, modus: 'aparte_lijst', lijst_naam: m.lijstNaam, bevestig }
        : { csv: m.csv, label: m.label, per_dag: Number(m.perDag) || 10, bevestig };
      const j = await post('/api/opvolging-leads-import', body);
      m.vv = j;
      if (bevestig) {
        m.klaar = j.gemaakt + ' kaart' + (j.gemaakt === 1 ? '' : 'en') + ' gemaakt' +
          (j.verhuisd ? ', ' + j.verhuisd + ' verhuisd uit de pot' : '') + ' — ' + j.samenvatting + '.' +
          ((j.fouten || []).length ? ' ' + j.fouten.length + ' rij(en) mislukt.' : '') +
          (j.lijst ? ' De lijst staat als eigen chip bovenaan.' : '');
        // Na sluiten meteen in de nieuwe lijst.
        if (j.lijst && j.lijst.id) _ld.pot = 'lijst:' + j.lijst.id;
        _ld.vuil = true;
      }
    } catch (e) { m.fout = e.message || 'Niet gelukt'; } finally { _ld.bezig = false; teken(); }
  }

  async function lijstActie(id, actie) {
    if (_ld.bezig) return;
    _ld.bezig = true; teken();
    try {
      await post('/api/opvolging-leads-lijst', { lijst_id: id, actie });
      if (actie === 'archiveer') { _ld.pot = 'belrij'; toast('Lijst gearchiveerd. Terug te vinden onder Gearchiveerd.'); }
      else toast('Lijst teruggezet.');
      herlaadAlles();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); } finally { _ld.bezig = false; teken(); }
  }

  /** Tweeling van beoordeelAfronden() in api/_lib/opvolging-leads-pot.js. */
  function beoordeel(k, categorie) {
    if (AFROND_ZONDER_DREMPEL.includes(String(categorie || '')) || k.contact) return { genoeg: true, tekort: [] };
    const tekort = [];
    const b = Number(k.bel_totaal) || 0, d = Number(k.bel_dagen) || 0, w = Number(k.wa_totaal) || 0;
    if (b < AFROND_MIN_BEL) tekort.push('nog ' + (AFROND_MIN_BEL - b) + '× bellen');
    if (d < AFROND_MIN_BEL_DAGEN) tekort.push('bellen op ' + AFROND_MIN_BEL_DAGEN + ' verschillende dagen (nu ' + d + ')');
    if (w < AFROND_MIN_WA) tekort.push('minstens 1 WhatsApp');
    return { genoeg: tekort.length === 0, tekort };
  }
  function inspanning(k) {
    const b = k.bel_totaal || 0, d = k.bel_dagen || 0, w = k.wa_totaal || 0;
    return b + '× gebeld op ' + d + ' dag' + (d === 1 ? '' : 'en') + ', ' + w + ' WhatsApp' + (w === 1 ? '' : 's') + ', ' +
      (k.contact ? 'wel gesproken' : 'nooit gesproken');
  }
  function momentNl(isoTs) {
    try {
      return new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        .format(new Date(isoTs)).replace(/\./g, '');
    } catch (_) { return String(isoTs); }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ═════════════════════════════════════════════════════════════════════════
  /** De kaart van deze rij; maakt hem aan als hij er nog niet is. */
  async function zorgKaart(s) {
    const r = _ld.rijen.get(s);
    if (!r) throw new Error('Deze lead staat niet meer in de lijst. Herlaad.');
    if (r.kaart && r.kaart.taak_id) return { r, id: r.kaart.taak_id };
    const j = await post('/api/opvolging-leads-kaart', { lead_id: r.lead_id });
    const t = j.taak || {};
    r.kaart = {
      taak_id: j.taak_id, status: t.status || 'open', due: t.due || null, telefoon: t.telefoon || r.telefoon,
      bel_totaal: 0, bel_dagen: 0, wa_totaal: 0, bel_vandaag: 0, wa_vandaag: 0, pogingen: [], contact: false,
      reden_code: t.reden_code || null, badge_label: t.badge_label || null,
    };
    _ld.rijen.set('t:' + j.taak_id, r);
    // De pot Nieuw is na deze klik niet meer juist; bij sluiten opnieuw laden.
    _ld.vuil = true;
    return { r, id: j.taak_id };
  }

  async function metKaart(s, fn) {
    try { const { r, id } = await zorgKaart(s); await fn(id, r); } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  }

  function herlaadAlles() { leegCache(); _ld.vuil = false; teken(); }

  // ── Het gesprek volgen ───────────────────────────────────────────────────
  // De softphone zegt niet wanneer een gesprek klaar is; we kijken elke
  // seconde naar zijn status. Was hij actief en is hij het niet meer, dan is
  // er net opgehangen: dan vraagt het scherm hoe het ging. Zo hoeft Dave niets
  // te onthouden en klopt de belcadans.
  let _gesprekTimer = null;
  function stopVolgen() { if (_gesprekTimer) { clearInterval(_gesprekTimer); _gesprekTimer = null; } }
  function softphoneActief() {
    const sp = window.KlxSoftphone;
    if (!sp || typeof sp.getStatus !== 'function') return null;
    try {
      const st = sp.getStatus();
      return !!(st && (st.state === 'dialing' || st.state === 'ringing' || st.state === 'connected'));
    } catch (_) { return null; }
  }
  function volgGesprek(s, taakId) {
    stopVolgen();
    _ld.gesprek = { sleutel: s, taakId, sinds: Date.now(), gezienActief: false };
    if (typeof setInterval !== 'function') return;
    _gesprekTimer = setInterval(() => {
      const g = _ld.gesprek;
      if (!g) { stopVolgen(); return; }
      const actief = softphoneActief();
      if (actief === null) { stopVolgen(); return; }
      if (actief) { g.gezienActief = true; return; }
      if (g.gezienActief) {
        stopVolgen();
        _ld.gesprek = null;
        if (_ld.ronde) _ld.ronde.gebeld += 1;
        _ld.vuil = true;
        // Even wachten: de call-log moet eerst als belpoging op de kaart staan.
        setTimeout(() => {
          if (!_ld.modal || _ld.modal.soort === 'na') _ld.modal = { soort: 'uitkomst', sleutel: g.sleutel };
          teken();
        }, 900);
        return;
      }
      // Nooit gebeld (venster dicht zonder te bellen): na 3 minuten stoppen.
      if (Date.now() - g.sinds > 180000) { stopVolgen(); _ld.gesprek = null; teken(); }
    }, 1000);
  }

  function waTekst(r) {
    const vn = r.voornaam || String(r.naam || '').split(' ')[0] || '';
    const prod = r.product === '7-daagse' ? 'de 7-daagse' : r.product === 'Minicursus' ? 'de minicursus' : 'de cursus';
    return 'Hey ' + vn + ', Dave hier van De Forex Opleiding 👋 Ik probeerde je net even te bellen over ' + prod +
      '. Hoe bevalt het tot nu toe? Laat gerust weten wanneer ik je best kan bereiken, dan bel ik je dan.';
  }

  window.__opvLb = {
    import: () => { _ld.modal = { soort: 'import', modus: 'pot', label: '', lijstNaam: '', perDag: 10, csv: '', vv: null, fout: null, klaar: null }; teken(); },
    impModus: (v) => {
      const m = _ld.modal; if (!m || m.soort !== 'import') return;
      m.modus = v === 'aparte_lijst' ? 'aparte_lijst' : 'pot'; m.vv = null; m.klaar = null; m.fout = null; teken();
    },
    archief: () => { _ld.archiefOpen = !_ld.archiefOpen; teken(); },
    lijstArchiveer: (id) => {
      if (typeof confirm === 'function' && !confirm('Lijst archiveren? De chip verdwijnt; de leads en hun historiek blijven bewaard en de lijst is terug te zetten via Gearchiveerd.')) return;
      lijstActie(id, 'archiveer');
    },
    lijstTerug: (id) => lijstActie(id, 'terugzetten'),
    impVeld: (veld, v) => { const m = _ld.modal; if (!m || m.soort !== 'import') return; m[veld] = v; m.vv = null; m.klaar = null; },
    impBestand: (el) => {
      const f = el && el.files && el.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { const m = _ld.modal; if (!m || m.soort !== 'import') return; m.csv = String(rd.result || ''); m.vv = null; m.klaar = null; teken(); };
      rd.readAsText(f);
    },
    impVoor: () => impPost(false),
    // Iets aangepast na de voorvertoning? Dan eerst opnieuw kijken.
    impBevestig: () => impPost(!!(_ld.modal && _ld.modal.vv)),
    naarTab: () => { if (window.DFO && typeof window.DFO.goTab === 'function') window.DFO.goTab('Leads bellen'); },
    kiesPot: (code) => { _ld.pot = code; if (_ld.vuil) { leegCache(); _ld.vuil = false; } teken(); },
    herlaad: () => herlaadAlles(),
    filter: (aan) => { _ld.alleenWaarschuwing = !!aan; teken(); },
    bel: (s) => metKaart(s, async (id) => {
      if (_ld.modal) _ld.modal = null;
      volgGesprek('t:' + id, id);
      window.__opvBel(id, 'leads-bellen');
      teken();
    }),
    uitleg: () => { _ld.uitleg = !_ld.uitleg; teken(); },
    toonAlles: (code) => { _ld.toonAlles[code] = true; teken(); },
    startRonde: () => {
      _ld.ronde = { gebeld: 0, gestart: Date.now(), overgeslagen: new Set() };
      const d = huidigeBelrij();
      const eerste = d.items ? belrijItems(d)[0] : null;
      if (eerste) window.__opvLb.bel(sleutel(eerste)); else teken();
    },
    stopRonde: () => { _ld.ronde = null; teken(); },
    overslaan: (s) => { if (_ld.ronde) _ld.ronde.overgeslagen.add(s); teken(); },
    uitkomst: (s) => metKaart(s, async (id) => { _ld.modal = { soort: 'uitkomst', sleutel: 't:' + id }; teken(); }),
    kiesUitkomst: async (s, u) => {
      const m = _ld.modal; if (_ld.bezig) return;
      if (u === 'foutief_nummer' && typeof confirm === 'function' && !confirm('Foutief nummer: de lead wordt afgerond en komt niet terug. Doorgaan?')) return;
      _ld.bezig = true; if (m) m.fout = null; teken();
      try {
        const { id } = await zorgKaart(s);
        const j = await post('/api/opvolging-taak-update', { taak_id: id, actie: 'uitkomst', uitkomst: u });
        leegCache(); _ld.vuil = false;
        if (u === 'gesproken') _ld.modal = { soort: 'watnu', sleutel: s, naGesprek: true };
        else if (u === 'foutief_nummer') { _ld.modal = null; toast('Afgerond: foutief nummer.'); }
        else _ld.modal = { soort: 'na', sleutel: s, uitkomst: u, plan: j.plan || null };
      } catch (e) { if (_ld.modal) _ld.modal.fout = e.message || 'Niet gelukt'; } finally { _ld.bezig = false; teken(); }
    },
    waNaCall: (s) => metKaart(s, async (id, r) => {
      _ld.modal = null; _ld.vuil = true;
      window.__opvWa(id);
      if (typeof window.__opvGesprekTyp === 'function') window.__opvGesprekTyp(waTekst(r));
      teken();
    }),
    opnieuwOm: (s, w) => metKaart(s, async (id) => {
      const wanneer = w === 'u1' ? new Date(Date.now() + 3600000).toISOString()
        : w === 'u3' ? new Date(Date.now() + 3 * 3600000).toISOString() : w;
      try {
        await post('/api/opvolging-taak-update', { taak_id: id, actie: 'opnieuw_om', wanneer });
        _ld.modal = null; herlaadAlles(); toast('Staat even uit Nu bellen; komt terug op het gekozen moment.');
      } catch (e) { if (_ld.modal) { _ld.modal.fout = e.message || 'Niet gelukt'; teken(); } }
    }),
    logDag: (delta) => {
      const st = _ld.logboek;
      const basis = (st.data && st.data.dag) || st.dag;
      if (!basis) return;
      const d = new Date(basis + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + delta);
      const nieuw = d.toISOString().slice(0, 10);
      if (st.data && st.data.vandaag && nieuw > st.data.vandaag) return;
      st.dag = nieuw; st.data = null; st.fout = null; teken();
    },
    logTab: (t) => { _ld.logTab = t === 'leads' ? 'leads' : 'tijdlijn'; teken(); },
    wa: (s) => metKaart(s, async (id) => { window.__opvWa(id); }),
    hist: (s) => { const r = _ld.rijen.get(s); if (r && r.kaart) window.__opvHist(r.kaart.taak_id); },
    watNu: (s) => metKaart(s, async () => { _ld.modal = { soort: 'watnu', sleutel: s }; teken(); }),
    open: (soort, s) => {
      const vooraf = soort === 'afronden' && _ld.modal && _ld.modal.categorie ? _ld.modal.categorie : null;
      _ld.modal = { soort, sleutel: s, noot: '', categorie: vooraf, due: soort === 'terug' ? dagPlus(2) : null }; teken();
    },
    afrondNietBereikbaar: (s) => {
      const r = _ld.rijen.get(s); const k = (r && r.kaart) || {};
      _ld.modal = { soort: 'afronden', sleutel: s, categorie: 'niet_bereikbaar',
        noot: RONDES_MAX + ' belrondes zonder gehoor (' + (k.bel_totaal || 0) + '× gebeld op ' + (k.bel_dagen || 0) + ' dagen, ' + (k.wa_totaal || 0) + ' WhatsApp).' };
      teken();
    },
    sluit: () => { _ld.modal = null; if (_ld.vuil) herlaadAlles(); else teken(); },
    typ: (v) => { if (_ld.modal) _ld.modal.noot = String(v == null ? '' : v); },
    kiesDag: (d, stil) => { if (!_ld.modal) return; _ld.modal.due = d; if (!stil) teken(); },
    kiesCat: (c) => { if (!_ld.modal) return; _ld.modal.categorie = c; teken(); },
    inplannen: (s) => metKaart(s, async (id) => {
      _ld.modal = null; _ld.vuil = true;
      G().openModal({ soort: 'inplannen', taakId: id });
    }),
    doorsturen: (s) => metKaart(s, async (id, r) => {
      _ld.modal = null; _ld.vuil = true;
      window.__opvDoorsturen(id, 'eerste', { naam: r.naam, telefoon: (r.kaart && r.kaart.telefoon) || r.telefoon });
    }),
    herinnering: (s) => metKaart(s, async (id, r) => {
      window.__opvDoorsturen(id, 'herinnering', { naam: r.naam, telefoon: (r.kaart && r.kaart.telefoon) || r.telefoon });
    }),
    laterVandaag: (s) => metKaart(s, async (id) => {
      await post('/api/opvolging-taak-update', { taak_id: id, actie: 'later_vandaag' });
      _ld.modal = null; herlaadAlles(); toast('Staat vandaag nog in Bezig.');
    }),
    bewaarTerug: async () => {
      const m = _ld.modal; if (!m || _ld.bezig) return;
      const el = document.getElementById('lb-dt');
      if (el && el.value) m.due = el.value;
      const noot = String(m.noot || '').trim();
      if (!noot) { m.fout = 'Schrijf op wat de lead zei.'; teken(); return; }
      if (!m.due || m.due < dagPlus(1)) { m.fout = 'Kies een dag vanaf morgen.'; teken(); return; }
      _ld.bezig = true; m.fout = null; teken();
      try {
        const { id } = await zorgKaart(m.sleutel);
        await post('/api/opvolging-taak-update', { taak_id: id, actie: 'verplaats', due: m.due, terugbel_notitie: noot });
        _ld.modal = null; herlaadAlles(); toast('Op ' + m.due + ' staat hij in Terugbellen.');
      } catch (e) { m.fout = e.message || 'Niet gelukt'; teken(); } finally { _ld.bezig = false; teken(); }
    },
    bewaarAfronden: async () => {
      const m = _ld.modal; if (!m || _ld.bezig) return;
      const noot = String(m.noot || '').trim();
      if (!m.categorie) { m.fout = 'Kies een categorie.'; teken(); return; }
      if (noot.length < AFROND_MIN_NOTITIE) { m.fout = 'Schrijf minstens ' + AFROND_MIN_NOTITIE + ' tekens uitleg.'; teken(); return; }
      _ld.bezig = true; m.fout = null; teken();
      try {
        const { id } = await zorgKaart(m.sleutel);
        await post('/api/opvolging-taak-update', { taak_id: id, actie: 'archiveer', archief_categorie: m.categorie, archief_reden: noot });
        _ld.modal = null; herlaadAlles(); toast('Afgerond.');
      } catch (e) { m.fout = e.message || 'Niet gelukt'; teken(); } finally { _ld.bezig = false; teken(); }
    },
    bewaarInst: async () => {
      const st = _ld.inst; if (st.bezig) return;
      const v = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
      const body = {
        agenda_link: v('lb-link').trim(), bericht: v('lb-bericht'), herinnering: v('lb-herinnering'),
        kanaal: v('lb-kanaal') || 'meta', module: v('lb-module') || 'leadsonderhoud',
      };
      st.bezig = true; st.melding = null; teken();
      try {
        const j = await post('/api/opvolging-agenda-instelling', body);
        st.data = { ...(st.data || {}), ...j, instelling: j.instelling, mag_bewerken: true };
        st.melding = { ok: true, tekst: 'Bewaard.' };
      } catch (e) { st.melding = { ok: false, tekst: e.message || 'Niet bewaard' }; } finally { st.bezig = false; teken(); }
    },
  };

  function lbStijl() {
    if (typeof document === 'undefined' || document.getElementById('opv-lb-stijl')) return;
    const el = document.createElement('style');
    el.id = 'opv-lb-stijl';
    el.textContent = `
.opv .leadsknop{display:inline-flex;align-items:center;gap:6px}
.opv .lb-badge{background:var(--o-red);color:#fff;border-radius:999px;font-size:11px;font-weight:700;padding:1px 7px;line-height:16px}
.opv.lb .lb-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr)) minmax(0,2fr);gap:8px;margin:0 0 14px}
.opv.lb .lb-cel{background:#fff;border:1px solid var(--o-line);border-radius:12px;padding:10px 12px;box-shadow:var(--o-sh);min-width:0}
.opv.lb .lb-cel b{display:block;font-size:20px;letter-spacing:-.02em}
.opv.lb .lb-cel span{font-size:11.5px;color:var(--o-muted)}
.opv.lb .lb-potten{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;background:#f3f4f6;padding:5px;border-radius:12px}
.opv.lb .lb-pot{border:0;background:transparent;border-radius:9px;padding:7px 11px;font:inherit;font-size:13px;cursor:pointer;color:var(--o-ink);display:inline-flex;gap:7px;align-items:center}
.opv.lb .lb-pot .n{font-size:11.5px;font-weight:700;color:var(--pk)}
.opv.lb .lb-pot.on{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1);font-weight:650}
.opv.lb .lb-pot.lb-lijst{--pk:#0e7490;border:1px dashed #67b7c9;background:#ecf8fb;color:#0b4f60}
.opv.lb .lb-pot.lb-lijst.on{background:#fff;border-style:solid;border-color:#0e7490}
.opv.lb .lb-sep{width:1px;align-self:stretch;background:#d1d5db;margin:4px 4px}
.opv.lb .lb-pot .af{font-size:11px;color:#06603b}
.opv.lb .lb-pot.lb-arch{color:var(--o-muted)}
.opv.lb .lb-archief{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:-4px 0 12px;font-size:12.5px}
.opv.lb .lb-lijstkop{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;background:#ecf8fb;border:1px solid #b6e0ea;border-radius:12px;padding:10px 14px;margin:0 0 10px}
.opv.lb .lb-lijstkop .nm{font-size:15px;font-weight:700;margin:0 0 4px}
.opv.lb .lb-lh{font-size:14px;font-weight:700;margin:6px 0 8px}
.opv.lb .lb-lh .n{font-size:12px;font-weight:700;background:#eef0f3;border-radius:999px;padding:0 8px}
.opv .tag.t-teal{background:#d9f1f6;color:#0b4f60}
.opv .tag.lb-lijsttag{background:#ecf8fb;color:#0b4f60;border:1px dashed #67b7c9}
.opv .lb-keuzes{display:flex;flex-direction:column;gap:6px;margin:0 0 6px}
.opv .lb-keuze{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--o-line);border-radius:10px;padding:8px 10px;cursor:pointer;font-size:13px}
.opv .lb-keuze.on{border-color:#0e7490;background:#f3fbfd}
.opv .lb-keuze input{margin-top:3px}
.opv .lb-keuze b{display:block}
.opv .lb-keuze span span{display:block;font-size:12px;color:var(--o-muted)}
.opv.lb .lb-opener{font-size:12.5px;color:#374151;margin:2px 0 4px}
.opv.lb .lb-chip{display:inline-block;font-size:11.5px;border-radius:999px;padding:2px 8px;margin:0 4px 3px 0;background:#f1f2f4;color:#374151}
.opv.lb .lb-chip.goed{background:var(--o-grns);color:#06603b}
.opv.lb .lb-chip.let{background:var(--o-ambs);color:#8a5200}
.opv.lb .lb-zacht{font-size:11.5px;color:var(--o-muted);margin-right:8px}
.opv.lb .lb-pil{display:inline-block;font-size:11.5px;border:1px solid var(--o-line);border-radius:999px;padding:1px 8px;margin-right:4px;color:var(--o-muted)}
.opv.lb .lb-pil.groen{border-color:#9fe0c4;color:#06603b;background:var(--o-grns)}
.opv.lb .lb-noot{font-size:12px;color:#4b5563;margin-top:4px}
.opv.lb .lb-weg{font-size:12px;color:var(--o-muted);margin:-4px 0 10px}
.opv.lb .lb-som{display:flex;flex-wrap:wrap;gap:12px;font-size:12.5px;margin:0 0 8px}
.opv.lb .lb-filter{font-size:12.5px;display:inline-flex;gap:6px;align-items:center;margin:0 0 8px}
.opv.lb .lb-tabel{overflow-x:auto;background:#fff;border:1px solid var(--o-line);border-radius:12px}
.opv.lb .lb-tabel table{width:100%;border-collapse:collapse;font-size:12.5px}
.opv.lb .lb-tabel th{text-align:left;color:var(--o-muted);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--o-line)}
.opv.lb .lb-tabel td{padding:8px 10px;border-bottom:1px solid #f1f2f4;vertical-align:top}
.opv.lb .lb-tabel td.nt{max-width:260px}
.opv.lb .lb-tabel tr{cursor:pointer}
.opv.lb .lb-beheer{margin-top:28px;background:#fff;border:1px solid var(--o-line);border-radius:14px;padding:16px 18px}
.opv.lb .lb-beheer h4{margin:0 0 8px}
.opv.lb .lb-beheer label{display:block;font-size:12.5px;font-weight:650;margin:10px 0 4px}
.opv.lb .lb-beheer input,.opv.lb .lb-beheer textarea{width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--o-line);border-radius:9px}
.opv.lb .lb-beheer .obtn{margin-top:12px}
.opv .lb-snel,.opv .lb-cats{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.opv.lb .lb-sectie{margin:0 0 18px}
.opv.lb .lb-skop{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin:0 0 6px;padding:0 2px}
.opv.lb .lb-skop b{font-size:14px}
.opv.lb .lb-skop .n{font-size:12px;font-weight:700;background:#eef0f3;border-radius:999px;padding:0 8px}
.opv.lb .lb-suitleg{font-size:12px;color:var(--o-muted)}
.opv.lb .lb-s-reageerde .lb-skop .n,.opv.lb .lb-s-terugbellen .lb-skop .n{background:#ede7ff;color:#5b2fd6}
.opv.lb .lb-s-vers .lb-skop .n{background:var(--o-grns);color:#06603b}
.opv.lb .lb-s-uitgebeld .lb-skop .n{background:var(--o-reds);color:#a1150b}
.opv.lb .lb-waarom{font-size:11px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#5b2fd6;margin:0 0 2px}
.opv.lb .lb-rij.lb-nu{outline:2px solid var(--o-acc,#2f6bff);outline-offset:-2px}
.opv.lb .lb-plan{color:#1f3b8a}
.opv.lb .lb-antwoord{background:#f5f0ff;border-radius:8px;padding:5px 9px;color:#3b1d8f;font-style:italic;display:inline-block}
.opv.lb .lb-noot.zacht,.opv .zacht{color:var(--o-muted)}
.opv .lb-uk{border-color:#e08700;color:#8a5200;background:var(--o-ambs)}
.opv.lb .lb-meer{margin:6px 0 0}
.opv.lb .lb-rondestart{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 14px;font-size:12.5px;color:var(--o-muted)}
.opv.lb .lb-rondebalk{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;background:#0f172a;color:#fff;border-radius:12px;padding:10px 14px;margin:0 0 14px;font-size:13px}
.opv.lb .lb-rondebalk .zacht{color:#cbd5e1}
.opv.lb .lb-rb-knoppen{display:flex;gap:6px;flex-wrap:wrap}
.opv.lb .lb-uitleg{background:#fff;border:1px solid var(--o-line);border-radius:14px;padding:12px 18px;margin:0 0 14px;font-size:13px;line-height:1.5}
.opv.lb .lb-uitleg h4{margin:4px 0 6px}
.opv.lb .lb-uitleg li{margin:0 0 6px}
.opv.lb .lb-logboek{margin-top:28px}
.opv.lb .lb-logkop{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 0 10px}
.opv.lb .lb-logkop h4{margin:0;font-size:16px}
.opv.lb .lb-dagnav{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.opv.lb .lb-strip8{grid-template-columns:repeat(6,minmax(0,1fr))}
.opv.lb .lb-logtabs{display:flex;gap:6px;margin:0 0 8px;background:#f3f4f6;padding:5px;border-radius:12px;width:max-content;max-width:100%}
.opv.lb .lb-tijdlijn{background:#fff;border:1px solid var(--o-line);border-radius:12px;max-height:520px;overflow:auto}
.opv.lb .lb-tl{display:flex;gap:10px;align-items:baseline;padding:7px 12px;border-bottom:1px solid #f1f2f4;font-size:12.5px}
.opv.lb .lb-tl .t{color:var(--o-muted);font-variant-numeric:tabular-nums;min-width:38px}
.opv.lb .lb-tl .i{width:18px;text-align:center}
.opv.lb .lb-tl-ingepland{background:#f0fbf6}
.opv.lb .lb-tl-afgerond{background:#fafafa}
.opv .tag.t-purple{background:#ede7ff;color:#5b2fd6}
.opv .lb-l{display:block;font-size:12.5px;font-weight:650;margin:10px 0 4px}
@media (max-width:720px){.opv.lb .lb-strip,.opv.lb .lb-strip8{grid-template-columns:repeat(3,minmax(0,1fr))}.opv.lb .lb-cel.breed{grid-column:span 3}}`;
    document.head.appendChild(el);
  }

  window.DFO.VIEWS['opvolging/Leads bellen'] = leadsView;
  // Voor tests: de staat van buitenaf kunnen zetten zonder netwerk.
  window.__opvLeadsState = _ld;
})();
