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
//   3. De tab Leadsonderhoud → The Lab: de testmachine voor de advertenties.
//      Per hook of campagne, per periode: leads → ingelogd → Lab gestart →
//      afgewerkt → sessie geboekt → klant, met de conversie per stap.
//      Bron: GET /api/lab-statistieken.
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

  /* ── 2 · De index en de badge ─────────────────────────────────────────── */
  const idx = { geladen: false, bezig: false, leads: {}, emails: {} };
  async function laadIndex() {
    if (idx.geladen || idx.bezig) return;
    idx.bezig = true;
    try {
      const j = await haalJson('/api/lab-lead-index');
      idx.leads = j.leads || {}; idx.emails = j.emails || {};
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
    /** Badge op basis van alleen een e-mail (kennismakingsgesprekken met bron the-lab). */
    badgeVoorEmail(email, altijd) {
      laadIndex();
      const em = String(email || '').toLowerCase();
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

    let h = '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">' + statusPil(d.status) +
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
    if (d.opvolging.length) {
      h += sectie('Opvolging', d.opvolging.map((o) => regel(datum(o.aangemaakt), esc(o.stap + ' · ' + o.kanaal + ' · ' + o.status))).join(''));
    }
    return h;
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
      const j = await haalJson('/api/lab-statistieken?van=' + r.van + '&tot=' + r.tot + '&per=' + st.per);
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
    const kop = ['', 'Touches', 'Leads', 'Ingelogd', 'Lab gestart', 'Afgewerkt', 'Sessie geboekt', 'Klant'];
    const cel = (n, van) => '<td style="padding:8px 10px;text-align:right;white-space:nowrap"><b>' + n + '</b>' + (van != null ? '<div style="font-size:11px;color:var(--text-3)">' + pct(n, van) + '</div>' : '') + '</td>';
    const rij = (r, vet) => '<tr style="border-top:1px solid var(--border)' + (vet ? ';background:var(--surface-2,rgba(0,0,0,.02))' : '') + '">' +
      '<td style="padding:8px 10px;font-weight:' + (vet ? 700 : 600) + '">' + esc(r.sleutel) + '</td>' +
      '<td style="padding:8px 10px;text-align:right;color:var(--text-3)">' + r.touches + '</td>' +
      cel(r.leads, null) + cel(r.ingelogd, r.leads) + cel(r.gestart, r.ingelogd) + cel(r.afgewerkt, r.gestart) + cel(r.geboekt, r.leads) + cel(r.klant, r.geboekt) + '</tr>';
    return '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<thead><tr>' + kop.map((k, i) => '<th style="padding:8px 10px;text-align:' + (i ? 'right' : 'left') + ';font-size:11px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.04em">' + k + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + d.rijen.map((r) => rij(r, false)).join('') + (d.totaal ? rij(d.totaal, true) : '') + '</tbody></table></div>' +
      '<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Percentages: ingelogd/gestart/afgewerkt t.o.v. de stap ervoor; <b>sessie geboekt t.o.v. leads</b> (de KPI); klant t.o.v. geboekt. Testaanmeldingen tellen niet mee.</div>';
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

  function labView() {
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
        '<div style="font-weight:700;font-size:15px;margin-right:auto">The Lab · per ' + (st.per === 'campagne' ? 'campagne' : 'hook') + '</div>' +
        '<div style="display:flex;gap:4px">' + knoppen('preset', [['vandaag', 'Vandaag'], ['7d', '7 dagen'], ['30d', '30 dagen'], ['90d', '90 dagen']]) + '</div>' +
        '<div style="display:flex;gap:4px">' + knoppen('per', [['hook', 'Per hook'], ['campagne', 'Per campagne'], ['landing', 'Per landing']]) + '</div>' +
      '</div>' + inhoud + '</div>';
  }

  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['leadsonderhoud/The Lab'] = labView;
})();
