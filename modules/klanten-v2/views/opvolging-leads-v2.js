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

(function () {
  if (!window.DFO) return;
  window.DFO.VIEWS = window.DFO.VIEWS || {};

  const POTTEN = [
    { code: 'terugbellen', label: 'Terugbellen', kleur: '#7c4dff' },
    { code: 'verlopen', label: 'Termijn verlopen', kleur: '#e08700' },
    { code: 'bezig', label: 'Bezig', kleur: '#2f6bff' },
    { code: 'nieuw', label: 'Nieuw', kleur: '#0ea968' },
    { code: 'wacht', label: 'Wacht op inplanning', kleur: '#2f6bff' },
    { code: 'later', label: 'Later', kleur: '#6b7280' },
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
  };

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
  async function laadPot(code) {
    const st = _ld.potten[code] = _ld.potten[code] || { laden: false, data: null, fout: null };
    if (st.laden) return;
    st.laden = true; st.fout = null;
    const j = await haal('/api/opvolging-leads?pot=' + encodeURIComponent(code));
    st.laden = false;
    if (j.__error) st.fout = j.__error;
    else {
      st.data = j;
      // De telling komt met elke pot mee; zo blijven de tellers vers.
      _ld.telling.data = j;
      for (const r of j.items || []) _ld.rijen.set(sleutel(r), r);
    }
    teken();
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

  /** De knop rechtsboven in Vandaag, met badge = terugbellen + verlopen + nieuw-heet. */
  window.__opvLeadsKnop = () => {
    const R = window.RBAC;
    if (R && typeof R.canSync === 'function' && R.canSync('opvolging.leads.view') === false) return '';
    if (!_ld.telling.data && !_ld.telling.laden && !_ld.telling.fout) straks(laadTelling);
    const n = _ld.telling.data ? _ld.telling.data.badge : null;
    return '<button class="obtn leadsknop" onclick="window.__opvLb.naarTab()" title="Terugbellen + termijn verlopen + nieuwe hete leads">' +
      '&#128222; Leads bellen' + (n ? ' <span class="lb-badge">' + esc(n) + '</span>' : '') + '</button>';
  };

  // ═════════════════════════════════════════════════════════════════════════
  // DE VIEW
  // ═════════════════════════════════════════════════════════════════════════
  function eerstePotMetInhoud(aantallen) {
    for (const p of POTTEN) if ((aantallen && aantallen[p.code]) > 0) return p.code;
    return 'nieuw';
  }

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
    h += '<div class="kop"><div class="info"><b>Trage momenten?</b> Bel warme proefleads en laat ze een call inplannen.</div>' +
      g.waLamp() + '</div>';
    h += dagstrip(t.data);
    if (t.fout) h += '<div class="warn">De potten konden niet geladen worden: ' + esc(t.fout) + '</div>';
    for (const m of (t.data && t.data.meldingen) || []) h += '<div class="warn2">' + esc(m) + '</div>';

    h += '<div class="lb-potten">' + POTTEN.map((p) => {
      const n = aantallen ? aantallen[p.code] : null;
      return '<button class="lb-pot' + (p.code === pot ? ' on' : '') + '" style="--pk:' + p.kleur + '" onclick="window.__opvLb.kiesPot(\'' + p.code + '\')">' +
        esc(p.label) + '<span class="n">' + (n == null ? '&middot;' : esc(n)) + '</span></button>';
    }).join('') + '</div>';

    if (!pot) h += '<div class="agleeg">Laden&hellip;</div>';
    else if (ps && ps.fout) h += '<div class="warn">' + esc(ps.fout) + ' <button class="obtn" onclick="window.__opvLb.herlaad()">Opnieuw</button></div>';
    else if (!ps || !ps.data) h += '<div class="agleeg">Laden&hellip;</div>';
    else h += potInhoud(pot, ps.data);

    h += beheerBlok();
    h += '</div>';
    return h + leadsModalHtml() + g.modalHtml() + g.waPaneelHtml() + g.gesprekPaneelHtml() + g.doorstuurPaneelHtml();
  }

  function dagstrip(d) {
    if (!d || !d.dag) return '';
    const v = d.dag;
    const cel = (n, l) => '<div class="lb-cel"><b>' + esc(n) + '</b><span>' + esc(l) + '</span></div>';
    const pct = d.week && d.week.pct != null ? d.week.pct + ' %' : '—';
    return '<div class="lb-strip">' +
      cel(v.gebeld, 'gebeld') + cel(v.gesproken, 'gesproken') + cel(v.doorgestuurd, 'doorgestuurd') +
      cel(v.ingepland, 'ingepland') + cel(v.afgerond, 'afgerond') +
      '<div class="lb-cel breed"><b>' + esc(pct) + '</b><span>doorgestuurd &rarr; ingepland (7 d' +
      (d.week ? ', ' + esc(d.week.ingepland) + '/' + esc(d.week.doorgestuurd) : '') + ')</span></div></div>';
  }

  const POT_UITLEG = {
    terugbellen: 'Ze vroegen zelf om een later moment, en die dag is er. Warmer dan de rest: eerst deze.',
    verlopen: 'Ze kregen de agenda maar plantten binnen 48 uur niets in. Nog eens bellen of de link opnieuw sturen.',
    bezig: 'Al eens gebeld of geappt, nog geen uitkomst. Oudste laatste poging bovenaan.',
    nieuw: 'Nog niet aangeraakt. Warmste bovenaan.',
    wacht: 'Agenda doorgestuurd; ze kiezen zelf. Na 48 uur zonder afspraak komen ze terug in Termijn verlopen.',
    later: 'Komen terug op de afgesproken dag.',
    ingepland: 'Gelukt — laatste 30 dagen.',
    afgerond: 'Weggegooid in de laatste 60 dagen, met de moeite die ervoor gedaan is.',
  };

  function potInhoud(pot, d) {
    const items = d.items || [];
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
    if (k && pot === 'terugbellen' && k.terugbel_notitie) extra += '<div class="lb-noot">&#128221; ' + esc(k.terugbel_notitie) + '</div>';
    if (k && pot === 'later') extra += '<div class="lb-noot">Terug op ' + esc(k.due) + (k.terugbel_notitie ? ' &middot; ' + esc(k.terugbel_notitie) : '') + '</div>';
    if (k && pot === 'wacht') {
      extra += '<div class="lb-noot"><span class="tag ' + (k.resterende_uren ? 't-blue' : 't-red') + '">' +
        (k.resterende_uren ? 'nog ' + esc(k.resterende_uren) + 'u van 48' : 'termijn voorbij') + '</span>' +
        (k.laatste_herinnering_at ? ' &middot; herinnering gestuurd' : '') + '</div>';
    }
    if (k && pot === 'ingepland' && k.afspraak_ref && k.afspraak_ref.scheduled_at) {
      extra += '<div class="lb-noot">&#9989; Call op ' + esc(momentNl(k.afspraak_ref.scheduled_at)) + '</div>';
    }

    let knoppen = '';
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

    return '<div class="row lb-rij"><div class="who">' +
      '<div class="nm">' + esc(r.naam) +
      (r.product_label ? ' <span class="tag t-grey">' + esc(r.product_label) + '</span>' : '') +
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
      '<label>Agendalink (https://…)</label><input id="lb-link" type="url" value="' + esc(i.agenda_link || '') + '" placeholder="https://">' +
      '<label>Bericht bij doorsturen</label><textarea id="lb-bericht" rows="6">' + esc(i.bericht || '') + '</textarea>' +
      '<label>Herinnering</label><textarea id="lb-herinnering" rows="4">' + esc(i.herinnering || '') + '</textarea>' +
      (st.melding ? '<div class="' + (st.melding.ok ? 'ronde' : 'warn') + '">' + esc(st.melding.tekst) + '</div>' : '') +
      '<button class="obtn p" ' + (st.bezig ? 'disabled' : '') + ' onclick="window.__opvLb.bewaarInst()">' + (st.bezig ? 'Bewaren&hellip;' : 'Bewaren') + '</button></div>';
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
    const r = _ld.rijen.get(m.sleutel);
    if (!r) return '';
    const k = r.kaart || {};
    const s = m.sleutel;
    if (m.soort === 'watnu') {
      const verlopen = k.reden_code === 'inplantermijn_verlopen';
      const body =
        (r.opener ? '<div class="ronde">' + esc(r.opener) + '</div>' : '') +
        opt('&#128197;', 'var(--o-grns)', 'Inplannen via Zoom', 'Kies samen een moment terwijl je hem aan de lijn hebt. Daarmee is de kaart klaar.', "window.__opvLb.inplannen('" + s + "')") +
        opt('&#128233;', 'var(--o-accs)', verlopen ? 'Agenda opnieuw doorsturen' : 'Agenda doorsturen',
          'Verstuurt nu de agendalink via WhatsApp. Plant hij niets in binnen 48 uur, dan komt hij terug.', "window.__opvLb.doorsturen('" + s + "')") +
        opt('&#9200;', 'var(--o-purs)', 'Moet later terugkomen', 'Hij noemde zelf een later moment. Schrijf op wat hij zei.', "window.__opvLb.open('terug','" + s + "')") +
        opt('&#8595;', 'var(--o-ambs)', 'Later vandaag nog eens', 'Blijft vandaag in Bezig staan.', "window.__opvLb.laterVandaag('" + s + "')") +
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

  window.__opvLb = {
    naarTab: () => { if (window.DFO && typeof window.DFO.goTab === 'function') window.DFO.goTab('Leads bellen'); },
    kiesPot: (code) => { _ld.pot = code; if (_ld.vuil) { leegCache(); _ld.vuil = false; } teken(); },
    herlaad: () => herlaadAlles(),
    filter: (aan) => { _ld.alleenWaarschuwing = !!aan; teken(); },
    bel: (s) => metKaart(s, async (id) => { window.__opvBel(id, 'leads-bellen'); }),
    wa: (s) => metKaart(s, async (id) => { window.__opvWa(id); }),
    hist: (s) => { const r = _ld.rijen.get(s); if (r && r.kaart) window.__opvHist(r.kaart.taak_id); },
    watNu: (s) => metKaart(s, async () => { _ld.modal = { soort: 'watnu', sleutel: s }; teken(); }),
    open: (soort, s) => { _ld.modal = { soort, sleutel: s, noot: '', categorie: null, due: soort === 'terug' ? dagPlus(2) : null }; teken(); },
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
      const body = { agenda_link: v('lb-link').trim(), bericht: v('lb-bericht'), herinnering: v('lb-herinnering') };
      st.bezig = true; st.melding = null; teken();
      try {
        const j = await post('/api/opvolging-agenda-instelling', body);
        st.data = { ...(st.data || {}), instelling: j.instelling, mag_bewerken: true };
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
.opv .lb-l{display:block;font-size:12.5px;font-weight:650;margin:10px 0 4px}
@media (max-width:720px){.opv.lb .lb-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.opv.lb .lb-cel.breed{grid-column:span 3}}`;
    document.head.appendChild(el);
  }

  window.DFO.VIEWS['opvolging/Leads bellen'] = leadsView;
  // Voor tests: de staat van buitenaf kunnen zetten zonder netwerk.
  window.__opvLeadsState = _ld;
})();
