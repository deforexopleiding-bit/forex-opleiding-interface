// modules/klanten-v2/views/the-lab-v2.js
//
// The Lab in Leadsonderhoud (oktober 2026). Drie dingen:
//
//   1. window.DFOLabDossier.open({ leadId, email, naam })
//      Het Lab-dossier van één lead: status, tijd in The Lab, scores per
//      oefening, ALLE antwoorden + de drie kwalificatievragen, leadscore, hook
//      en campagne. Zodat Dave het bij de call kan aflezen. Bron:
//      GET /api/lab-dossier (CRM + LMS).
//   2. window.DFOLabIndex.badge(lead) / .badgeVoorEmail(email)
//      De badge "The Lab · H03" in Contacten en bij de kennismakingsgesprekken.
//      Bron: GET /api/lab-lead-index (één keer per paginalading).
//   3. De tab Leadsonderhoud → The Lab = het overzicht van ALLE trial-leads
//      (26 okt 2026: minicursus, 7-daagse, webinar, website én The Lab zijn
//      allemaal lab-leads in het echte LMS). Drie weergaven:
//        Overzicht — KPI's per product + de lijst per lead met status-chips
//                    (GET /api/trial-overzicht);
//        Bellijst  — wie nu het meest waard is om te bellen, met tel:-link,
//                    resultaat + notitie (POST /api/trial-belpoging) en CSV;
//        Ads (The Lab) — de testmachine per hook/campagne/landing
//                    (GET /api/lab-statistieken, product the-lab).
//
// Huisregel van dit scherm: "niets gevonden" en "kon niet ophalen" zijn twee
// verschillende teksten.
(function () {
  'use strict';
  window.DFO = window.DFO || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const rerender = () => { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };
  const datum = (iso) => {
    if (!iso) return '—';
    try { return new Intl.DateTimeFormat('nl-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Brussels' }).format(new Date(iso)); } catch (_) { return iso; }
  };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

  async function haalJson(url) {
    if (!window.KV || typeof window.KV.authedFetch !== 'function') throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await window.KV.authedFetch(url);
    let j = null;
    try { j = await resp.json(); } catch (_) { j = null; }
    if (!resp.ok) throw new Error((j && j.error) || ('HTTP ' + resp.status));
    return j;
  }

  const STATUS_KLEUR = {
    geboekt: 'var(--emerald,#1F9D6B)', afgewerkt: 'var(--teal,#0F8C8C)', bezig: 'var(--blue,#2F6FEB)',
    ingelogd: 'var(--amber,#B7791F)', aangemeld: 'var(--text-3,#7a8794)', verlopen: 'var(--rose,#C22B3E)', geen_account: 'var(--text-3,#7a8794)',
  };
  function statusPil(s) {
    if (!s) return '';
    const k = STATUS_KLEUR[s.code] || 'var(--text-3)';
    return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;border:1px solid ' + k + ';color:' + k + '">' + esc(s.label) + '</span>';
  }

  const PRODUCT_LABEL = { minicursus: 'Minicursus', '7-daagse': '7-daagse', webinar: 'Webinar', website: 'Website', 'the-lab': 'The Lab' };
  const PRODUCT_KLEUR = { minicursus: '#7C5CC4', '7-daagse': '#0A7490', webinar: '#B7791F', website: '#4a5a68', 'the-lab': '#1a2f3e' };
  function productChip(product, label, bron) {
    const p = product || 'the-lab';
    const k = PRODUCT_KLEUR[p] || '#4a5a68';
    return '<span title="' + esc(bron ? 'bron ' + bron : '') + '" style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;background:' + k + ';color:#fff">' + esc(label || PRODUCT_LABEL[p] || p) + '</span>';
  }
  const RESULTAAT_LABEL = { geen_antwoord: 'Geen antwoord', voicemail: 'Voicemail', gesproken: 'Gesproken', sessie_geboekt: 'Sessie geboekt', terugbellen: 'Terugbellen', geen_interesse: 'Geen interesse', verkeerd_nummer: 'Verkeerd nummer' };
  const CHIP_KLEUR = { al_student: 'var(--brand,#0A7490)', klant: 'var(--emerald,#1F9D6B)', geboekt: 'var(--emerald,#1F9D6B)', ingelogd: 'var(--blue,#2F6FEB)', niet_ingelogd: 'var(--text-3,#7a8794)', video: 'var(--teal,#0F8C8C)', lab: 'var(--amber,#B7791F)', lab_af: 'var(--teal,#0F8C8C)', verlopen: 'var(--rose,#C22B3E)', afgemeld: 'var(--rose,#C22B3E)' };
  function chips(lijst, titels) {
    return (lijst || []).map((c) => '<span ' + (c.code === 'video' && titels && titels.length ? 'title="' + esc(titels.join(' · ')) + '" ' : '') + 'style="display:inline-block;margin:0 4px 3px 0;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid ' + (CHIP_KLEUR[c.code] || 'var(--text-3)') + ';color:' + (CHIP_KLEUR[c.code] || 'var(--text-3)') + '">' + esc(c.label) + '</span>').join('');
  }

  /* ── 2 · De index en de badge ─────────────────────────────────────────── */
  const idx = { geladen: false, bezig: false, leads: {}, emails: {}, trials: {} };
  async function laadIndex() {
    if (idx.geladen || idx.bezig) return;
    idx.bezig = true;
    try {
      const j = await haalJson('/api/lab-lead-index');
      idx.leads = j.leads || {}; idx.emails = j.emails || {}; idx.trials = j.trials || {};
      idx.geladen = true;
      rerender();
    } catch (e) {
      console.warn('[the-lab] index (soft):', e && e.message);
    } finally { idx.bezig = false; }
  }
  function badgeHtml(hook, attrs) {
    return '<span class="kv-lab-badge" ' + (attrs || '') + ' title="Kwam binnen via The Lab — klik voor het Lab-dossier" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:700;letter-spacing:.02em;background:#1a2f3e;color:#f2e3c6">The Lab' + (hook ? ' · ' + esc(hook) : '') + '</span>';
  }
  window.DFOLabIndex = {
    laad: laadIndex,
    /** Badge voor een lead-rij ({ id, email, bron }). Leeg als hij er niet bij hoort. */
    badge(l) {
      if (!l) return '';
      laadIndex();
      const hit = (l.id && idx.leads[l.id]) || (l.email && idx.emails[String(l.email).toLowerCase()]);
      if (!hit && !/^the-lab(-v\d+)?$/.test(String(l.bron || ''))) return '';
      return badgeHtml(hit && hit.hook, 'onclick="event.stopPropagation();window.DFOLabDossier.open({leadId:' + (l.id ? "'" + esc(l.id) + "'" : 'null') + ',email:' + (l.email ? "'" + esc(String(l.email).toLowerCase()) + "'" : 'null') + '})"');
    },
    /** De belofte van een trial-lead op e-mail ('minicursus', …) of null. */
    productVoorEmail(email) {
      laadIndex();
      const t = idx.trials[String(email || '').toLowerCase()];
      return t ? t.product : null;
    },
    /** "Strategiesessie · via Minicursus" voor een afspraak met bron the-lab. */
    sessieLabelVoorEmail(email) {
      const p = this.productVoorEmail(email);
      return 'Strategiesessie · via ' + (PRODUCT_LABEL[p] || (p ? p : 'The Lab'));
    },
    /** Badge op basis van alleen een e-mail (kennismakingsgesprekken met bron the-lab). */
    badgeVoorEmail(email, altijd) {
      laadIndex();
      const em = String(email || '').toLowerCase();
      const tp = em && idx.trials[em] && idx.trials[em].product;
      // Een trial van een andere belofte: "via Minicursus" in plaats van "The Lab".
      if (tp && tp !== 'the-lab') return ' <span title="Trial via ' + esc(PRODUCT_LABEL[tp] || tp) + ' — klik voor het dossier" style="cursor:pointer;margin-left:6px" onclick="event.stopPropagation();window.DFOLabDossier.open({email:\'' + esc(em) + '\'})">' + productChip(tp, 'via ' + (PRODUCT_LABEL[tp] || tp)) + '</span>';
      const hit = em && idx.emails[em];
      if (!hit && !altijd) return '';
      return badgeHtml(hit && hit.hook, 'onclick="event.stopPropagation();window.DFOLabDossier.open({email:\'' + esc(em) + '\'})"');
    },
  };

  /* ── 1 · Het dossier ──────────────────────────────────────────────────── */
  const ROOT_ID = 'kv-lab-dossier';
  let dos = null;

  function sectie(titel, inhoud) {
    return '<div style="margin-top:16px"><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">' + esc(titel) + '</div>' + inhoud + '</div>';
  }
  function regel(label, waarde) {
    return '<div style="display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px"><div style="flex:0 0 42%;color:var(--text-3)">' + esc(label) + '</div><div style="flex:1;min-width:0">' + waarde + '</div></div>';
  }

  function dossierHtml(d) {
    if (dos.laden) return '<div style="padding:24px;color:var(--text-3)">Het Lab-dossier wordt opgehaald…</div>';
    if (dos.fout) return '<div style="padding:16px;color:var(--rose,#C22B3E)">Kon het dossier niet ophalen: ' + esc(dos.fout) + '</div>';
    if (!d) return '<div style="padding:16px;color:var(--text-3)">Deze lead deed (nog) niet mee aan The Lab.</div>';

    let h = '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">' + statusPil(d.status) + productChip(d.product, d.product_label, d.bron) +
      (d.hook ? badgeHtml(d.hook, '') : '') +
      (d.campagne ? '<span style="font-size:12px;color:var(--text-3)">campagne ' + esc(d.campagne) + '</span>' : '') + '</div>';
    if (d.lms_fout) h += '<div style="margin-top:10px;padding:8px 12px;background:var(--amber-soft,#FFF4E0);border-radius:6px;font-size:12px">Het LMS-deel kon niet opgehaald worden: ' + esc(d.lms_fout) + '. Wat hieronder staat, komt alleen uit het CRM.</div>';

    const s = d.sessie;
    const a = d.account;
    let tijd = '';
    tijd += regel('Aangemeld', esc(datum(d.aanmeldingen[0] && d.aanmeldingen[0].aangemaakt)) + (d.aanmeldingen.length > 1 ? ' <span style="color:var(--text-3)">(' + d.aanmeldingen.length + '× aangemeld)</span>' : ''));
    if (a) {
      tijd += regel('Eerste login', a.eerste_login_op ? esc(datum(a.eerste_login_op)) : '<span style="color:var(--text-3)">nog niet ingelogd</span>');
      tijd += regel('Toegang tot', esc(datum(a.toegang_tot)));
    }
    if (s) {
      tijd += regel('Waar in The Lab', s.afgerond ? 'Afgewerkt' : esc('stap ' + s.stap + (s.stappen ? ' van ' + s.stappen : '') + (s.stap_naam ? ' · ' + s.stap_naam : '')));
      tijd += regel('Tijd in The Lab', s.minuten != null ? esc(s.minuten + ' min') : '—');
      tijd += regel('Laatste activiteit', esc(datum(s.bijgewerkt_op)));
    } else if (a) {
      tijd += regel('Waar in The Lab', '<span style="color:var(--text-3)">nog niet gestart</span>');
    }
    const geboekt = (a && a.sessie_moment) || (d.afspraken[0] && d.afspraken[0].scheduled_at);
    tijd += regel('Strategiesessie', geboekt ? '<b>' + esc(datum(geboekt)) + '</b>' : '<span style="color:var(--text-3)">niet geboekt</span>');
    h += sectie('Verloop', tijd);

    // Welke ingang hij koos en wat hij buiten de simulatie deed (kaart, video's).
    if (d.route || (d.gebeurtenissen && d.gebeurtenissen.length)) {
      let rt = '';
      if (d.route) rt += regel('Gekozen route', '<b>' + esc(d.route.label) + '</b>' + (d.route.op ? ' <span style="color:var(--text-3)">· ' + esc(datum(d.route.op)) + '</span>' : ''));
      if (d.video && (d.video.gestart || d.video.voltooid)) rt += regel('Video\'s', esc(d.video.gestart + ' gestart · ' + d.video.voltooid + ' uitgekeken'));
      rt += (d.gebeurtenissen || []).map((g) => regel(datum(g.op), esc(g.regel))).join('');
      h += sectie('Route en gedrag', rt);
    }

    if (d.kwalificatie.length) {
      h += sectie('Kwalificatie (einde The Lab)', d.kwalificatie.map((k) => regel(k.vraag, '<b>' + esc(k.antwoord) + '</b>')).join(''));
    }

    if (s && s.leadscore) {
      const ls = s.leadscore;
      const totaal = ls.totaal != null ? ls.totaal : ls.score;
      const temp = ls.temperatuur && (ls.temperatuur.label || ls.temperatuur);
      h += sectie('Leadscore', regel('Score', '<b>' + esc(totaal) + '</b>' + (temp ? ' · ' + esc(typeof temp === 'string' ? temp : JSON.stringify(temp)) : '')));
    }
    if (s && (s.baseline != null || s.eindcijfer != null)) {
      h += sectie('Zelfinschatting', regel('Bij de start', esc(s.baseline ?? '—')) + regel('Op het einde', esc(s.eindcijfer ?? '—')));
    }

    if (d.vragen.length) {
      h += sectie('Antwoorden (' + d.vragen.length + ')', d.vragen.map((v) => regel(v.vraag, esc(v.antwoord || '—'))).join(''));
    }
    const taken = s ? Object.entries(s.taken || {}) : [];
    if (taken.length) h += sectie('Oefeningen', taken.map(([t, uit]) => regel(t, esc(uit))).join(''));
    if (s && s.trades.length) {
      h += sectie('Trades in The Lab', s.trades.map((t) => regel(t.paar + ' · ' + (t.bron || ''), '<b style="color:' + (t.r > 0 ? 'var(--emerald,#1F9D6B)' : 'var(--rose,#C22B3E)') + '">' + (t.r > 0 ? '+' : '') + esc(Number(t.r).toFixed(2)) + 'R</b>')).join(''));
    }
    if (d.aanmeldingen.length) {
      h += sectie('Aanmeldingen', d.aanmeldingen.map((x) => regel(datum(x.aangemaakt),
        esc([x.hook, x.utm_source, x.utm_campaign].filter(Boolean).join(' · ') || '—') +
        '<div style="font-size:11.5px;color:var(--text-3)">mail ' + esc(x.mail_status || '—') + ' · WhatsApp ' + esc(x.wa_status || '—') + (x.toestemming ? '' : ' · geen toestemming') + (x.is_test ? ' · TEST' : '') + '</div>')).join(''));
    }
    const tl = tijdlijn(d);
    if (tl.length) h += sectie('Tijdlijn', tl.map((t) => regel(datum(t.op), (t.icoon ? '<span style="display:inline-block;min-width:62px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)">' + esc(t.icoon) + '</span>' : '') + esc(t.tekst))).join(''));
    return h;
  }

  /** Alles wat er met deze lead gebeurde, in de tijd: aanmelding, berichten, logins, video's, Lab, boeking, belpogingen. */
  function tijdlijn(d) {
    const t = [];
    for (const a of d.aanmeldingen || []) t.push({ op: a.aangemaakt, icoon: 'Aanmelding', tekst: 'Aangemeld via ' + (PRODUCT_LABEL[a.product] || a.product || 'The Lab') + (a.bron ? ' (' + a.bron + ')' : '') + (a.hook ? ' · ' + a.hook : '') });
    for (const b of d.berichten || []) t.push({ op: b.verstuurd_op, icoon: b.kanaal === 'whatsapp' ? 'WhatsApp' : 'Mail', tekst: (b.kanaal === 'whatsapp' ? 'WhatsApp' : 'Mail') + ' · ' + b.soort + ' · ' + b.status + (b.fout ? ' (' + b.fout + ')' : '') });
    for (const o of d.opvolging || []) if (o.status !== 'verstuurd') t.push({ op: o.aangemaakt, icoon: 'Motor', tekst: 'Motor · ' + o.stap + ' · ' + o.kanaal + ' ' + o.status + (o.detail ? ' (' + o.detail + ')' : '') });
    const a = d.account;
    if (a && a.eerste_login_op) t.push({ op: a.eerste_login_op, icoon: 'Login', tekst: 'Eerste login' });
    if (a && a.laatste_login_op && a.laatste_login_op !== a.eerste_login_op) t.push({ op: a.laatste_login_op, icoon: 'Login', tekst: 'Laatste login' });
    for (const g of d.gebeurtenissen || []) t.push({ op: g.op, icoon: /video/.test(g.soort) ? 'Video' : 'LMS', tekst: g.regel });
    if (d.sessie && d.sessie.gestart_op) t.push({ op: d.sessie.gestart_op, icoon: 'Lab', tekst: 'Startte The Lab' });
    if (d.sessie && d.sessie.afgerond) t.push({ op: d.sessie.bijgewerkt_op, icoon: 'Lab', tekst: 'Werkte The Lab af' + ((d.vragen || []).length ? ' · ' + d.vragen.length + ' antwoorden' : '') });
    if (a && a.sessie_geboekt_op) t.push({ op: a.sessie_geboekt_op, icoon: 'Boeking', tekst: 'Boekte de strategiesessie' + (a.sessie_moment ? ' voor ' + datum(a.sessie_moment) : '') });
    for (const b of d.belpogingen || []) t.push({ op: b.aangemaakt, icoon: 'Bellen', tekst: 'Belpoging · ' + (RESULTAAT_LABEL[b.resultaat] || b.resultaat) + (b.door_naam ? ' · ' + b.door_naam : '') + (b.notitie ? ' — ' + b.notitie : '') });
    return t.filter((x) => x.op).sort((x, y) => String(x.op).localeCompare(String(y.op)));
  }

  function teken() {
    const root = document.getElementById(ROOT_ID);
    if (!root || !dos) return;
    root.querySelector('[data-ld-box]').innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border)">' +
        '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:15px">Lab-dossier</div>' +
        '<div style="font-size:12px;color:var(--text-3);margin-top:2px">' + esc(dos.naam || (dos.data && dos.data.email) || dos.email || '') + '</div></div>' +
        '<button class="btn btn-ghost btn-sm" data-ld-sluit aria-label="Sluiten">✕</button>' +
      '</div>' +
      '<div style="padding:14px 18px;max-height:calc(100vh - 140px);overflow:auto">' + dossierHtml(dos.data) + '</div>';
    root.querySelector('[data-ld-sluit]').onclick = sluit;
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); sluit(); } }
  function sluit() {
    const root = document.getElementById(ROOT_ID);
    if (root) root.remove();
    document.removeEventListener('keydown', onKey, true);
    dos = null;
  }
  async function open({ leadId = null, email = null, naam = null } = {}) {
    sluit();
    dos = { leadId, email, naam, laden: true, fout: null, data: null };
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:16px';
    root.innerHTML = '<div data-ld-box style="width:100%;max-width:620px;background:var(--surface,#fff);color:var(--text-1);border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden"></div>';
    root.addEventListener('click', (e) => { if (e.target === root) sluit(); });
    document.body.appendChild(root);
    document.addEventListener('keydown', onKey, true);
    teken();
    const huidig = dos;
    try {
      const qs = leadId ? 'lead_id=' + encodeURIComponent(leadId) + (email ? '&email=' + encodeURIComponent(email) : '') : 'email=' + encodeURIComponent(email || '');
      const j = await haalJson('/api/lab-dossier?' + qs);
      if (dos !== huidig) return;
      dos.data = j.dossier;
    } catch (e) {
      if (dos !== huidig) return;
      dos.fout = (e && e.message) || 'onbekende fout';
    }
    dos.laden = false;
    teken();
  }
  /**
   * Kaart voor de leadkaart (Leads → detail): status + kwalificatie in één
   * oogopslag, en de knop naar het volledige dossier. Leeg als de lead nooit
   * via The Lab kwam. Het dossier wordt één keer per lead opgehaald.
   */
  const kaartCache = new Map();
  function kaart(l) {
    if (!l || !l.id) return '';
    laadIndex();
    const hit = idx.leads[l.id] || (l.email && idx.emails[String(l.email).toLowerCase()]);
    if (!hit && !/^the-lab(-v\d+)?$/.test(String(l.bron || ''))) return '';
    let c = kaartCache.get(l.id);
    if (!c) {
      c = { laden: true, fout: null, d: null };
      kaartCache.set(l.id, c);
      haalJson('/api/lab-dossier?lead_id=' + encodeURIComponent(l.id) + (l.email ? '&email=' + encodeURIComponent(String(l.email).toLowerCase()) : ''))
        .then((j) => { c.d = j.dossier; }).catch((e) => { c.fout = (e && e.message) || 'onbekende fout'; })
        .finally(() => { c.laden = false; rerender(); });
    }
    let body;
    if (c.laden) body = '<div style="color:var(--text-3);font-size:12.5px">Lab-dossier wordt opgehaald…</div>';
    else if (c.fout) body = '<div style="color:var(--rose,#C22B3E);font-size:12.5px">Kon het Lab-dossier niet ophalen: ' + esc(c.fout) + '</div>';
    else if (!c.d) body = '<div style="color:var(--text-3);font-size:12.5px">Nog geen Lab-gegevens voor deze lead.</div>';
    else {
      body = '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">' + statusPil(c.d.status) + (c.d.hook ? badgeHtml(c.d.hook, '') : '') + '</div>' +
        (c.d.kwalificatie || []).map((k) => '<div class="sv-row"><span>' + esc(k.vraag) + '</span><b>' + esc(k.antwoord) + '</b></div>').join('') +
        (c.d.sessie && c.d.sessie.minuten != null ? '<div class="sv-row"><span>Tijd in The Lab</span><b>' + esc(c.d.sessie.minuten) + ' min</b></div>' : '') +
        '<div class="sv-row"><span>Antwoorden</span><b>' + (c.d.vragen || []).length + '</b></div>';
    }
    return '<div class="sv-card" data-lab-kaart><div class="sv-card-head">The Lab</div><div class="sv-card-body">' + body +
      '<button class="btn btn-sm" style="margin-top:8px" onclick="window.DFOLabDossier.open({leadId:\'' + esc(l.id) + '\'' + (l.email ? ',email:\'' + esc(String(l.email).toLowerCase()) + '\'' : '') + ',naam:\'' + esc(l.naam || '') + '\'})">Open het Lab-dossier</button></div></div>';
  }

  window.DFOLabDossier = { open, sluit, kaart };

  /* ── 3 · De tab Leadsonderhoud → The Lab ──────────────────────────────── */
  const st = window.__labStatsState = window.__labStatsState || {
    preset: '30d', per: 'hook', loading: false, fetched: false, error: null, data: null, lastKey: null, _seq: 0,
  };

  function nlVandaag() {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t).value;
    return g('year') + '-' + g('month') + '-' + g('day');
  }
  function plusDagen(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n, 12));
    const p2 = (x) => (x < 10 ? '0' : '') + x;
    return dt.getUTCFullYear() + '-' + p2(dt.getUTCMonth() + 1) + '-' + p2(dt.getUTCDate());
  }
  function bereik() {
    const t = nlVandaag();
    if (st.preset === 'vandaag') return { van: t, tot: t };
    if (st.preset === '7d') return { van: plusDagen(t, -6), tot: t };
    if (st.preset === '90d') return { van: plusDagen(t, -89), tot: t };
    return { van: plusDagen(t, -29), tot: t };
  }

  async function laadStats(force) {
    const r = bereik();
    const key = r.van + '|' + r.tot + '|' + st.per;
    if (!force && st.lastKey === key && (st.fetched || st.loading)) return;
    st.loading = true; st.error = null; st.lastKey = key;
    const seq = ++st._seq;
    rerender();
    try {
      const j = await haalJson('/api/lab-statistieken?van=' + r.van + '&tot=' + r.tot + '&per=' + st.per + '&product=the-lab');
      if (seq !== st._seq) return;
      st.data = j; st.fetched = true;
    } catch (e) {
      if (seq !== st._seq) return;
      st.error = (e && e.message) || 'onbekende fout';
    }
    st.loading = false;
    rerender();
  }

  window.__labZet = function (veld, waarde) { st[veld] = waarde; laadStats(true); };

  function knoppen(veld, opties) {
    return opties.map(([w, l]) => '<button class="btn btn-sm ' + (st[veld] === w ? 'btn-primary' : 'btn-ghost') + '" onclick="window.__labZet(\'' + veld + '\',\'' + w + '\')">' + esc(l) + '</button>').join('');
  }

  function funnelTabel(d) {
    const kop = ['', 'Touches', 'Leads', 'Route 20 · 5 · praten', 'Ingelogd', 'Lab gestart', 'Afgewerkt', 'Sessie geboekt', 'Klant'];
    const cel = (n, van) => '<td style="padding:8px 10px;text-align:right;white-space:nowrap"><b>' + n + '</b>' + (van != null ? '<div style="font-size:11px;color:var(--text-3)">' + pct(n, van) + '</div>' : '') + '</td>';
    const rij = (r, vet) => '<tr style="border-top:1px solid var(--border)' + (vet ? ';background:var(--surface-2,rgba(0,0,0,.02))' : '') + '">' +
      '<td style="padding:8px 10px;font-weight:' + (vet ? 700 : 600) + '">' + esc(r.sleutel) + '</td>' +
      '<td style="padding:8px 10px;text-align:right;color:var(--text-3)">' + r.touches + '</td>' +
      cel(r.leads, null) +
      '<td style="padding:8px 10px;text-align:right;white-space:nowrap;color:var(--text-2)">' + (r.route ? (r.route.lab + ' · ' + r.route.kort + ' · ' + r.route.praten) : '—') + '</td>' +
      cel(r.ingelogd, r.leads) + cel(r.gestart, r.ingelogd) + cel(r.afgewerkt, r.gestart) + cel(r.geboekt, r.leads) + cel(r.klant, r.geboekt) + '</tr>';
    return '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<thead><tr>' + kop.map((k, i) => '<th style="padding:8px 10px;text-align:' + (i ? 'right' : 'left') + ';font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">' + k + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + d.rijen.map((r) => rij(r, false)).join('') + (d.totaal ? rij(d.totaal, true) : '') + '</tbody></table></div>' +
      '<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Percentages: ingelogd/gestart/afgewerkt t.o.v. de stap ervoor; <b>sessie geboekt t.o.v. leads</b> (de KPI); klant t.o.v. geboekt. Testaanmeldingen tellen niet mee.</div>' +
      routeBlok(d.per_route);
  }

  /** Geboekt per gekozen ingang van Jouw route (20 min / 5 min / meteen praten). */
  function routeBlok(pr) {
    if (!pr) return '';
    const naam = { lab: 'Ik heb 20 minuten (The Lab)', kort: 'Ik heb 5 minuten', praten: 'Ik wil meteen praten', geen: 'Nog geen keuze' };
    const rijen = ['lab', 'kort', 'praten', 'geen'].map((k) => '<tr style="border-top:1px solid var(--border)"><td style="padding:6px 10px">' + esc(naam[k]) + '</td>' +
      '<td style="padding:6px 10px;text-align:right"><b>' + pr[k].leads + '</b></td>' +
      '<td style="padding:6px 10px;text-align:right"><b>' + pr[k].geboekt + '</b> <span style="font-size:11px;color:var(--text-3)">' + pct(pr[k].geboekt, pr[k].leads) + '</span></td></tr>').join('');
    return '<div style="margin-top:16px;font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Per gekozen route</div>' +
      '<table data-lab-per-route style="width:100%;border-collapse:collapse;font-size:13px;margin-top:4px"><thead><tr>' +
      '<th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--text-3)">Ingang</th><th style="text-align:right;padding:6px 10px;font-size:11px;color:var(--text-3)">Leads</th><th style="text-align:right;padding:6px 10px;font-size:11px;color:var(--text-3)">Geboekt</th></tr></thead><tbody>' + rijen + '</tbody></table>';
  }

  // "Plan je sessie met Dave" in het LMS: uitnodiging en vaste balk → boeking.
  const AANLEIDING = { tweede_pagina: '2e pagina', tijd: '45 s op een pagina', nieuwe_dag: 'terug op een nieuwe dag', video: 'na een video', exit: 'wilde de pagina verlaten' };
  function uitnodigingBlok(u) {
    if (!u || !u.totaal || !u.rijen || !u.rijen.length) return '';
    const kop = ['', 'Leads', 'Zagen uitnodiging', 'Keer getoond', 'Boekte in uitnodiging', 'Boekte na uitnodiging', 'Klikte balk', 'Boekte via balk'];
    const cel = (n, van) => '<td style="padding:8px 10px;text-align:right;white-space:nowrap"><b>' + n + '</b>' + (van != null ? '<div style="font-size:11px;color:var(--text-3)">' + pct(n, van) + '</div>' : '') + '</td>';
    const rij = (r, vet) => '<tr style="border-top:1px solid var(--border)' + (vet ? ';background:var(--surface-2,rgba(0,0,0,.02))' : '') + '">' +
      '<td style="padding:8px 10px;font-weight:' + (vet ? 700 : 600) + '">' + esc(r.sleutel) + '</td>' +
      cel(r.leads, null) + cel(r.gezien, r.leads) + '<td style="padding:8px 10px;text-align:right;color:var(--text-3)">' + r.getoond + '</td>' +
      cel(r.via_uitnodiging, r.gezien) + cel(r.geboekt_na, r.gezien) + cel(r.balk_geklikt, r.leads) + cel(r.via_balk, r.balk_geklikt) + '</tr>';
    const aanl = Object.keys(u.perAanleiding || {}).map((k) => {
      const a = u.perAanleiding[k];
      return esc(AANLEIDING[k] || k) + ': ' + a.getoond + '× getoond, ' + a.geboekt + ' geboekt';
    }).join(' · ');
    return '<div style="margin-top:22px;font-weight:600">Plan je sessie met Dave <span style="font-weight:400;color:var(--text-3);font-size:12px">— uitnodiging en vaste balk in het LMS → boeking</span></div>' +
      '<div style="overflow-x:auto;margin-top:8px" data-lab-uitnodiging><table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<thead><tr>' + kop.map((k, i) => '<th style="padding:8px 10px;text-align:' + (i ? 'right' : 'left') + ';font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">' + k + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + u.rijen.map((r) => rij(r, false)).join('') + rij(u.totaal, true) + '</tbody></table></div>' +
      '<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Boekte in/na uitnodiging t.o.v. wie ze zag; boekte via balk t.o.v. wie klikte.' + (aanl ? ' Per aanleiding — ' + aanl + '.' : '') + '</div>';
  }

  function leadLijst(leads) {
    if (!leads.length) return '<div style="color:var(--text-3);font-size:13px">Geen aanmeldingen in deze periode.</div>';
    return '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>' +
      ['Lead', 'Hook', 'Aangemeld', 'Status'].map((k) => '<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--text-3);text-transform:uppercase">' + k + '</th>').join('') +
      '</tr></thead><tbody>' + leads.map((l) =>
        '<tr style="border-top:1px solid var(--border);cursor:pointer" onclick="window.DFOLabDossier.open({leadId:' + (l.lead_id ? "'" + esc(l.lead_id) + "'" : 'null') + ',email:\'' + esc(l.email) + '\',naam:\'' + esc(l.voornaam || '') + '\'})">' +
          '<td style="padding:8px 10px"><b>' + esc(l.voornaam || '—') + '</b><div style="font-size:11.5px;color:var(--text-3)">' + esc(l.email) + (l.is_test ? ' · TEST' : '') + '</div></td>' +
          '<td style="padding:8px 10px">' + esc(l.hook || '—') + '<div style="font-size:11.5px;color:var(--text-3)">' + esc([l.campagne, l.landing].filter(Boolean).join(' · ')) + '</div></td>' +
          '<td style="padding:8px 10px;white-space:nowrap">' + esc(datum(l.aangemeld)) + '</td>' +
          '<td style="padding:8px 10px">' + statusPil(l.status) + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  function adsView() {
    laadStats(false);
    laadIndex();
    const d = st.data;
    let inhoud;
    if (st.loading && !d) inhoud = '<div style="color:var(--text-3)">Cijfers worden opgehaald…</div>';
    else if (st.error) inhoud = '<div style="color:var(--rose,#C22B3E)">Kon de cijfers niet ophalen: ' + esc(st.error) + ' <button class="btn btn-ghost btn-sm" onclick="window.__labZet(\'preset\',window.__labStatsState.preset)">Opnieuw</button></div>';
    else if (d && d.migratie_ontbreekt) inhoud = '<div style="color:var(--text-3)">De tabellen voor The Lab staan nog niet in de databank (migratie 2026-10-15-the-lab-leadmachine.sql).</div>';
    else if (d) {
      inhoud = (d.lms_fout ? '<div style="margin-bottom:10px;padding:8px 12px;background:var(--amber-soft,#FFF4E0);border-radius:6px;font-size:12px">Het LMS was niet bereikbaar: ingelogd/gestart/afgewerkt staan daardoor op 0. (' + esc(d.lms_fout) + ')</div>' : '') +
        funnelTabel(d) +
        uitnodigingBlok(d.uitnodiging) +
        '<div style="margin-top:22px;font-weight:600">Lab-leads <span style="font-weight:400;color:var(--text-3);font-size:12px">— klik voor het dossier</span></div>' +
        '<div style="margin-top:8px">' + leadLijst(d.leads || []) + '</div>';
    } else inhoud = '';
    return '<div class="card" style="padding:16px 18px">' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px">' +
        '<div style="font-weight:700;font-size:15px;margin-right:auto">Ads van The Lab · per ' + (st.per === 'campagne' ? 'campagne' : st.per === 'landing' ? 'landing' : 'hook') + '</div>' +
        '<div style="display:flex;gap:4px">' + knoppen('preset', [['vandaag', 'Vandaag'], ['7d', '7 dagen'], ['30d', '30 dagen'], ['90d', '90 dagen']]) + '</div>' +
        '<div style="display:flex;gap:4px">' + knoppen('per', [['hook', 'Per hook'], ['campagne', 'Per campagne'], ['landing', 'Per landing']]) + '</div>' +
      '</div>' + inhoud + '</div>';
  }

  /* ── 4 · Overzicht van alle trial-leads + bellijst (26 okt 2026) ─────── */
  const ov = window.__trialOvState = window.__trialOvState || {
    tab: 'overzicht', preset: '30d', product: 'alle', hook: '', variant: '',
    loading: false, error: null, data: null, lastKey: null, _seq: 0, bel: {}, bezig: null,
  };
  function ovBereik() {
    const t = nlVandaag();
    if (ov.preset === 'vandaag') return { van: t, tot: t };
    if (ov.preset === '7d') return { van: plusDagen(t, -6), tot: t };
    if (ov.preset === '90d') return { van: plusDagen(t, -89), tot: t };
    return { van: plusDagen(t, -29), tot: t };
  }
  function ovQs() {
    const r = ovBereik();
    return 'van=' + r.van + '&tot=' + r.tot + '&product=' + encodeURIComponent(ov.product) +
      (ov.hook ? '&hook=' + encodeURIComponent(ov.hook) : '') + (ov.variant ? '&variant=' + encodeURIComponent(ov.variant) : '');
  }
  async function laadOverzicht(force) {
    const key = ovQs();
    if (!force && ov.lastKey === key && (ov.data || ov.loading)) return;
    ov.loading = true; ov.error = null; ov.lastKey = key;
    const seq = ++ov._seq;
    rerender();
    try {
      const j = await haalJson('/api/trial-overzicht?' + key);
      if (seq !== ov._seq) return;
      ov.data = j;
    } catch (e) {
      if (seq !== ov._seq) return;
      ov.error = (e && e.message) || 'onbekende fout';
    }
    ov.loading = false;
    rerender();
  }
  window.__trialOvZet = function (veld, waarde) { ov[veld] = waarde; if (veld !== 'tab') laadOverzicht(true); else rerender(); };
  window.__trialBelVeld = function (email, veld, waarde) { ov.bel[email] = Object.assign(ov.bel[email] || {}, { [veld]: waarde }); };
  window.__trialBelNoteer = async function (email) {
    const r = (ov.data && ov.data.bellijst || []).find((x) => x.email === email);
    const b = ov.bel[email] || {};
    if (!r || !b.resultaat) { alert('Kies eerst een resultaat.'); return; }
    ov.bezig = email; rerender();
    try {
      await window.KV.authedJson('/api/trial-belpoging', { method: 'POST', body: JSON.stringify({ email, lead_id: r.lead_id, aanmelding_id: r.aanmelding_id, resultaat: b.resultaat, notitie: b.notitie || '' }) });
      delete ov.bel[email];
      if (window.KV.toast) window.KV.toast('Belpoging genoteerd');
      ov.bezig = null;
      await laadOverzicht(true);
    } catch (e) {
      ov.bezig = null;
      alert('Noteren mislukt: ' + ((e && e.message) || e));
      rerender();
    }
  };
  window.__trialBelCsv = async function () {
    try {
      const resp = await window.KV.authedFetch('/api/trial-overzicht?' + ovQs() + '&formaat=csv');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const url = URL.createObjectURL(await resp.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'bellijst-' + ovBereik().van + '-' + ovBereik().tot + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { alert('CSV ophalen mislukt: ' + ((e && e.message) || e)); }
  };

  function ovKnoppen(veld, opties) {
    return opties.map(([w, l]) => '<button class="btn btn-sm ' + (ov[veld] === w ? 'btn-primary' : 'btn-ghost') + '" onclick="window.__trialOvZet(\'' + veld + '\',\'' + esc(w) + '\')">' + esc(l) + '</button>').join('');
  }

  function kpiBlok(kpi) {
    const rijen = [['ingelogd', 'Ingelogd'], ['video', 'Video gezien'], ['lab_gestart', 'Lab gestart'], ['lab_afgewerkt', 'Lab afgewerkt'], ['geboekt', 'Sessie geboekt'], ['klant', 'Klant']];
    const tonen = (kpi || []).filter((k) => k.sleutel === 'totaal' || k.leads > 0 || ['minicursus', '7-daagse', 'webinar', 'the-lab'].includes(k.sleutel));
    return '<div data-trial-kpi style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:16px">' + tonen.map((k) => {
      const tot = k.sleutel === 'totaal';
      return '<div style="border:1px solid var(--border);border-radius:var(--r-md,12px);padding:12px 14px;background:' + (tot ? 'var(--surface-2,rgba(0,0,0,.02))' : 'var(--surface)') + ';cursor:' + (tot ? 'default' : 'pointer') + '"' + (tot ? '' : ' onclick="window.__trialOvZet(\'product\',\'' + esc(k.sleutel) + '\')"') + '>' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' + (tot ? '<b style="font-size:12px">Totaal</b>' : productChip(k.sleutel, k.label)) + '</div>' +
        '<div style="font-size:26px;font-weight:700;margin:6px 0 4px">' + k.leads + ' <span style="font-size:12px;font-weight:500;color:var(--text-3)">leads</span></div>' +
        rijen.map(([v, l]) => '<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;border-top:1px dashed var(--border)"><span style="color:var(--text-3)">' + l + '</span><span><b>' + k[v] + '</b> <span style="color:var(--text-3)">' + pct(k[v], k.leads) + '</span></span></div>').join('') +
        '</div>';
    }).join('') + '</div>';
  }

  function geledenTekst(iso) {
    if (!iso) return '—';
    const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    return d <= 0 ? 'vandaag' : d === 1 ? 'gisteren' : d + ' d geleden';
  }
  function dagenOverTekst(r) {
    if (r.dagen_over == null) return '—';
    if (r.dagen_over < 0) return '<span style="color:var(--rose,#C22B3E)">' + (-r.dagen_over) + ' d verlopen</span>';
    return r.dagen_over + ' d';
  }
  const dosKlik = (r) => 'window.DFOLabDossier.open({leadId:' + (r.lead_id ? "'" + esc(r.lead_id) + "'" : 'null') + ',email:\'' + esc(r.email) + '\',naam:\'' + esc(r.naam || '') + '\'})';

  function trialLijst(leads) {
    if (!leads.length) return '<div style="color:var(--text-3);font-size:13px">Geen trial-leads in deze periode.</div>';
    const th = (k, rechts) => '<th style="padding:8px 10px;text-align:' + (rechts ? 'right' : 'left') + ';font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap">' + k + '</th>';
    return '<div style="overflow-x:auto" data-trial-lijst><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>' +
      th('Lead') + th('Belofte') + th('Aangemeld') + th('Status') + th('Over', true) + th('Laatste bericht') + th('Laatste belpoging') +
      '</tr></thead><tbody>' + leads.map((r) =>
        '<tr style="border-top:1px solid var(--border);cursor:pointer" onclick="' + dosKlik(r) + '">' +
          '<td style="padding:8px 10px"><b>' + esc(r.naam) + '</b><div style="font-size:11.5px;color:var(--text-3)">' + esc(r.email) + (r.is_test ? ' · TEST' : '') + '</div></td>' +
          '<td style="padding:8px 10px;white-space:nowrap">' + productChip(r.product, r.product_label, r.bron) + '<div style="font-size:11px;color:var(--text-3);margin-top:2px">' + esc([r.bron, r.hook].filter(Boolean).join(' · ')) + '</div></td>' +
          '<td style="padding:8px 10px;white-space:nowrap">' + esc(datum(r.aangemeld)) + '</td>' +
          '<td style="padding:8px 10px;min-width:220px">' + chips(r.chips, r.video_titels) + '</td>' +
          '<td style="padding:8px 10px;text-align:right;white-space:nowrap">' + dagenOverTekst(r) + '</td>' +
          '<td style="padding:8px 10px;font-size:12px;white-space:nowrap">' + (r.laatste_bericht ? esc(r.laatste_bericht.stap) + ' · ' + esc(r.laatste_bericht.kanaal) + '<div style="color:var(--text-3)">' + esc(geledenTekst(r.laatste_bericht.op)) + '</div>' : '<span style="color:var(--text-3)">—</span>') + '</td>' +
          '<td style="padding:8px 10px;font-size:12px;white-space:nowrap">' + (r.laatste_belpoging ? esc(RESULTAAT_LABEL[r.laatste_belpoging.resultaat] || r.laatste_belpoging.resultaat) + '<div style="color:var(--text-3)">' + esc(geledenTekst(r.laatste_belpoging.op)) + '</div>' : '<span style="color:var(--text-3)">—</span>') + '</td>' +
        '</tr>').join('') + '</tbody></table></div>';
  }

  /** Wie al student is (geen trial): apart, buiten KPI's en bellijst. */
  function alStudentBlok(lijst) {
    if (!lijst.length) return '';
    return '<div style="font-weight:600;margin:18px 0 6px">Al student <span style="font-weight:400;color:var(--text-3);font-size:12px">(' + lijst.length + ') — vroeg een trial aan met een adres dat al toegang heeft; geen trial, telt niet mee</span></div>' +
      '<div style="overflow-x:auto" data-trial-al-student><table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>' + lijst.map((r) =>
        '<tr style="border-top:1px solid var(--border)"><td style="padding:6px 10px"><b>' + esc(r.naam) + '</b><div style="font-size:11.5px;color:var(--text-3)">' + esc(r.email) + (r.is_test ? ' · TEST' : '') + '</div></td>' +
        '<td style="padding:6px 10px">' + productChip(r.product, r.product_label, r.bron) + '</td>' +
        '<td style="padding:6px 10px;white-space:nowrap">' + esc(datum(r.aangemeld)) + '</td>' +
        '<td style="padding:6px 10px">' + chips(r.chips) + '</td></tr>').join('') + '</tbody></table></div>';
  }

  const GROEP_LABEL = { warm: 'Warm, geen sessie', ingelogd: 'Ingelogd, geen sessie', niet_ingelogd: 'Niet ingelogd (met toestemming)' };
  function bellijst(d) {
    const lijst = d.bellijst || [];
    if (!lijst.length) return '<div style="color:var(--text-3);font-size:13px">Niemand om te bellen in deze periode (geboekt, klant, afgemeld, test of zonder nummer tellen niet).</div>';
    const opties = Object.entries(RESULTAAT_LABEL).map(([k, l]) => '<option value="' + k + '">' + esc(l) + '</option>').join('');
    let groep = null;
    let h = '';
    for (const r of lijst) {
      if (r.bel_groep !== groep) {
        groep = r.bel_groep;
        h += '<div style="margin:14px 0 6px;font-weight:700;font-size:13px">' + esc(GROEP_LABEL[groep] || groep) + ' <span style="font-weight:400;color:var(--text-3)">(' + lijst.filter((x) => x.bel_groep === groep).length + ')</span></div>';
      }
      const b = ov.bel[r.email] || {};
      const tel = String(r.telefoon || '');
      h += '<div data-bel-rij style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm,8px);margin-bottom:6px;background:var(--surface)">' +
        '<div style="flex:1 1 240px;min-width:0"><a href="javascript:void(0)" onclick="' + dosKlik(r) + '" style="font-weight:700;color:inherit">' + esc(r.naam) + '</a> ' + productChip(r.product, r.product_label, r.bron) +
          '<div style="margin-top:4px">' + chips(r.chips, r.video_titels) + '</div>' +
          '<div style="font-size:11.5px;color:var(--text-3)">aangemeld ' + esc(datum(r.aangemeld)) + ' · ' + (r.dagen_over != null ? (r.dagen_over >= 0 ? r.dagen_over + ' d toegang over' : 'toegang verlopen') : '') +
          (r.laatste_belpoging ? ' · laatst gebeld ' + esc(geledenTekst(r.laatste_belpoging.op)) + ': ' + esc(RESULTAAT_LABEL[r.laatste_belpoging.resultaat] || r.laatste_belpoging.resultaat) + (r.laatste_belpoging.notitie ? ' — ' + esc(r.laatste_belpoging.notitie) : '') : '') + '</div></div>' +
        '<a class="btn btn-sm btn-primary" href="tel:' + esc(tel) + '" onclick="event.stopPropagation()" style="white-space:nowrap">Bel ' + esc(tel) + '</a>' +
        (d.belpogingen_ok
          ? '<select onchange="window.__trialBelVeld(\'' + esc(r.email) + '\',\'resultaat\',this.value)" style="padding:6px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface)"><option value="">Resultaat…</option>' + opties.replace('value="' + (b.resultaat || '') + '"', 'value="' + (b.resultaat || '') + '" selected') + '</select>' +
            '<input placeholder="Notitie" value="' + esc(b.notitie || '') + '" oninput="window.__trialBelVeld(\'' + esc(r.email) + '\',\'notitie\',this.value)" style="flex:1 1 160px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface)">' +
            '<button class="btn btn-sm" ' + (ov.bezig === r.email ? 'disabled' : '') + ' onclick="window.__trialBelNoteer(\'' + esc(r.email) + '\')">' + (ov.bezig === r.email ? 'Bezig…' : 'Noteer') + '</button>'
          : '') +
        '</div>';
    }
    return (d.belpogingen_ok ? '' : '<div style="margin-bottom:10px;padding:8px 12px;background:var(--amber-soft,#FFF4E0);border-radius:6px;font-size:12px">Resultaten noteren kan pas na de migratie 2026-10-26-trial-belpogingen.sql. De lijst en de CSV werken al.</div>') + h;
  }

  function filterBalk(d) {
    const producten = [['alle', 'Alle'], ['minicursus', 'Minicursus'], ['7-daagse', '7-daagse'], ['webinar', 'Webinar'], ['website', 'Website'], ['the-lab', 'The Lab']];
    const hooks = (d && d.hooks) || [];
    return '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px">' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap">' + ovKnoppen('preset', [['vandaag', 'Vandaag'], ['7d', '7 dagen'], ['30d', '30 dagen'], ['90d', '90 dagen']]) + '</div>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap">' + ovKnoppen('product', producten) + '</div>' +
      (hooks.length ? '<select onchange="window.__trialOvZet(\'hook\',this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface)"><option value="">Alle hooks</option>' + hooks.map((h) => '<option value="' + esc(h) + '"' + (ov.hook === h ? ' selected' : '') + '>' + esc(h) + '</option>').join('') + '</select>' : '') +
      '<input placeholder="Variant (v9…)" value="' + esc(ov.variant) + '" onchange="window.__trialOvZet(\'variant\',this.value.trim())" style="width:120px;padding:5px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface)">' +
      '</div>';
  }

  function labView() {
    laadIndex();
    const tabs = [['overzicht', 'Overzicht'], ['bellijst', 'Bellijst'], ['ads', 'Ads (The Lab)']];
    const tabBalk = '<div style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:14px;flex-wrap:wrap">' + tabs.map(([k, l]) =>
      '<button onclick="window.__trialOvZet(\'tab\',\'' + k + '\')" style="background:transparent;border:0;border-bottom:2px solid ' + (ov.tab === k ? 'var(--brand,#0A7490)' : 'transparent') + ';color:' + (ov.tab === k ? 'var(--brand,#0A7490)' : 'var(--text-2)') + ';padding:8px 14px;font-size:13px;font-weight:' + (ov.tab === k ? '600' : '500') + ';cursor:pointer;margin-bottom:-1px">' + l +
      (k === 'bellijst' && ov.data && ov.data.bellijst ? ' <span style="font-size:11px;color:var(--text-3)">(' + ov.data.bellijst.length + ')</span>' : '') + '</button>').join('') + '</div>';
    if (ov.tab === 'ads') return '<div>' + tabBalk + adsView() + '</div>';
    laadOverzicht(false);
    const d = ov.data;
    let inhoud;
    if (ov.loading && !d) inhoud = '<div style="color:var(--text-3)">Trial-leads worden opgehaald…</div>';
    else if (ov.error) inhoud = '<div style="color:var(--rose,#C22B3E)">Kon het overzicht niet ophalen: ' + esc(ov.error) + ' <button class="btn btn-ghost btn-sm" onclick="window.__trialOvZet(\'preset\',window.__trialOvState.preset)">Opnieuw</button></div>';
    else if (d && d.migratie_ontbreekt) inhoud = '<div style="color:var(--text-3)">De tabel lab_aanmeldingen staat nog niet in de databank.</div>';
    else if (d) {
      const meld = (d.meldingen || []).map((m) => '<div style="margin-bottom:8px;padding:8px 12px;background:var(--amber-soft,#FFF4E0);border-radius:6px;font-size:12px">' + esc(m) + '</div>').join('');
      inhoud = meld + (ov.tab === 'bellijst'
        ? '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div style="font-size:12px;color:var(--text-3)">Eerst warm zonder sessie, dan ingelogd zonder sessie, dan niet ingelogd met toestemming. Binnen een groep de hoogste score eerst; wie vandaag al gebeld werd schuift achteraan.</div><button class="btn btn-sm" onclick="window.__trialBelCsv()">CSV downloaden</button></div>' + bellijst(d)
        : kpiBlok(d.kpi) + '<div style="font-weight:600;margin:6px 0 8px">Trial-leads <span style="font-weight:400;color:var(--text-3);font-size:12px">— klik voor het dossier · % t.o.v. leads · testleads tellen niet mee in de cijfers</span></div>' + trialLijst(d.leads || []) + alStudentBlok(d.al_student || []));
    } else inhoud = '';
    return '<div class="card" style="padding:16px 18px">' + tabBalk +
      '<div style="font-weight:700;font-size:15px;margin-bottom:10px">Alle trial-leads · één login, elke belofte</div>' +
      filterBalk(d) + inhoud + '</div>';
  }

  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['leadsonderhoud/The Lab'] = labView;
})();
