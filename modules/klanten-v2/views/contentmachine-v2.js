// modules/klanten-v2/views/contentmachine-v2.js
//
// Module Contentmachine (2026-10-23) — Groei → Contentmachine.
// Eén knop per week: een volledige "drop" (webpagina, nieuwsbrief, Instagram-
// stories, Instagram-post, LinkedIn) uit wat er die week gebeurde.
//
//   Overzicht    — alle drops, nieuwste bovenaan, status/soort/format.
//   Nieuwe drop  — de invoer: datum, Vimeo (optioneel), "wat is er deze week
//                  gebeurd?", trade van de week, foto's (upload + AI-beschrijving),
//                  bibliotheek-kiezer, kanalen. Een concept wordt bewaard zodra je
//                  iets oplaadt of op Bewaar klikt.
//   Bibliotheek  — beelden opladen, taggen, toestemming beheren; seed-knop voor
//                  de masterclass-beelden.
//
// Data: /api/contentmachine/drops + /api/contentmachine/assets (recht content.machine).
// Beelden gaan rechtstreeks van de browser naar Storage (signed upload, bucket
// `content`), daarna registreert de API ze (type aan de bytes gecontroleerd).
//
// Renderen: de schil vervangt bij DFO.render() de hele inhoud. Tekstvelden
// schrijven daarom enkel naar de state (oninput, geen render) en asynchrone
// stukken (uploads, bibliotheek) tekenen alleen hun eigen blok opnieuw — zo
// verlies je nooit wat je aan het typen bent.
(function () {
  'use strict';
  window.DFO = window.DFO || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ZONE = 'Europe/Amsterdam';
  const toast = (m) => { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); };
  const api = (url, init) => window.KV.authedJson(url, init);
  const post = (url, b) => api(url, { method: 'POST', body: JSON.stringify(b) });
  const foutTekst = (e, val) => (e && e.body && e.body.error) || (e && e.message) || val;

  const vandaag = () => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  };
  const slugVan = (ymd) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? `${m[3]}-${m[2]}-${m[1].slice(2)}` : '—'; };
  const fmtDag = (ymd) => { try { return new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ymd + 'T12:00:00Z')); } catch { return ymd || '—'; } };
  const fmtTijd = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('nl-NL', { timeZone: ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
  const fmtStart = (sec) => { if (sec == null || sec === '') return ''; const t = Math.max(0, Math.floor(+sec)); const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(t / 60))}:${p(t % 60)}`; };
  const fmtDuur = (sec) => (sec ? `${Math.floor(sec / 60)} min` : '');
  const pill = (c, t, titel) => `<span class="pill pill-${c} nodot"${titel ? ` title="${esc(titel)}"` : ''}>${esc(t)}</span>`;

  const STATUS = {
    concept: ['neutral', 'Concept'], gegenereerd: ['accent', 'Gegenereerd'], goedgekeurd: ['warn', 'Goedgekeurd'],
    gepubliceerd: ['ok', 'Gepubliceerd'], gearchiveerd: ['neutral', 'Gearchiveerd'],
  };
  const FORMATS = {
    trade_ontleed: 'De trade ontleed', wat_zou_jij_doen: 'Wat zou jij doen?', achter_de_schermen: 'Achter de schermen',
    het_bewijs: 'Het bewijs', fout_van_de_week: 'De fout van de week', een_regel_diep: 'Eén regel, diep',
    vooruitblik: 'Vooruitblik', vraag_van_student: 'Vraag van een student',
  };
  const SOORTEN = [['payout', 'Payout'], ['trade', 'Trade'], ['chart', 'Chart'], ['masterclass', 'Masterclass'], ['team', 'Team'], ['community', 'Community'], ['overig', 'Overig']];
  const SOORT_LABEL = Object.fromEntries(SOORTEN);
  const KANALEN = [['pagina', 'Pagina'], ['nieuwsbrief', 'Nieuwsbrief'], ['stories', 'Stories'], ['post', 'Instagram-post'], ['linkedin', 'LinkedIn']];

  const leegForm = () => ({
    id: null, slug: null, status: 'concept', datum: vandaag(), vimeo_url: '', start: '', training_datum: '', vimeo_meta: null, vimeo_bezig: false, vimeo_fout: null,
    wat_gebeurde: '', trade_info: { paar: '', richting: '', uitleg: '', resultaat_r: '' }, notities: '',
    gekozen_asset_ids: [], kanalen: KANALEN.map((k) => k[0]),
  });

  const st = window.__cmState = window.__cmState || {
    lijst: { loading: false, fetched: false, error: null, drops: [], migratie: false },
    form: leegForm(),
    dropAssets: [],      // beelden van de drop in het formulier
    bezig: [],           // lopende uploads { tmp, naam, fase, fout }
    bewaren: false,
    bib: { loading: false, fetched: false, error: null, assets: [], filter: 'all', open: null, bezig: [] },
    kiezerFilter: 'all',
    seed: { bezig: false, resultaat: null },
  };

  function rerender() { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); }
  /** Teken één blok opnieuw (zonder het hele scherm en dus zonder focusverlies). */
  function teken(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html; else rerender();
  }

  // ── Overzicht ─────────────────────────────────────────────────────────────
  async function laadLijst(force) {
    const L = st.lijst;
    if (L.loading || (L.fetched && !force)) return;
    L.loading = true; L.error = null; rerender();
    // Cijfers per drop (zelfde bron als Trainingdrops + top-3 blokken van de Weekeditie) — fail-soft.
    const cijfers = api('/api/contentmachine/data').then((j) => {
      window.__cmData = j;
      return (j && j.drops) || {};
    }).catch((e) => { console.warn('[contentmachine-v2] cijfers niet beschikbaar:', e && e.status); return null; });
    try {
      const j = await api('/api/contentmachine/drops');
      L.drops = Array.isArray(j.drops) ? j.drops : []; L.migratie = false;
      L.cijfers = await cijfers;
    } catch (e) {
      L.migratie = e && e.body && e.body.code === 'MIGRATIE_NODIG';
      L.error = e && e.status === 403 ? 'Geen toegang tot de Contentmachine (recht content.machine).' : foutTekst(e, 'Kon de drops niet laden');
      console.error('[contentmachine-v2] lijst laden mislukt:', e && e.status, e && (e.body || e.message));
    }
    L.loading = false; L.fetched = true; rerender();
  }

  window.__cmVernieuw = () => laadLijst(true);
  window.__cmNieuw = () => {
    st.form = leegForm(); st.dropAssets = []; st.bezig = [];
    if (window.DFO.goTab) window.DFO.goTab('Nieuwe drop');
  };
  /** Invoerformulier van een bestaande drop (concept, of "Invoer aanpassen" vanuit het werkblad). */
  window.__cmOpenInvoer = async (id) => {
    try {
      const j = await api('/api/contentmachine/drops?id=' + encodeURIComponent(id));
      laadInForm(j.drop, j.assets || []);
      if (window.DFO.goTab) window.DFO.goTab('Nieuwe drop');
      try { window.scrollTo(0, 0); } catch (_) {}
    } catch (e) { toast(foutTekst(e, 'Drop openen mislukt.')); }
  };
  /** Klik in het overzicht: concept → invoer, anders → werkblad. */
  window.__cmOpen = (id) => {
    const d = st.lijst.drops.find((x) => x.id === id);
    if (d && d.status !== 'concept' && typeof window.__cmWbOpen === 'function') { window.__cmWbOpen(id); return; }
    window.__cmOpenInvoer(id);
  };
  window.__cmOpenToets = (e, id) => { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); window.__cmOpen(id); } };

  function laadInForm(d, assets) {
    const i = d.input || {};
    const t = i.trade_info || {};
    st.form = {
      id: d.id, slug: d.slug, status: d.status, datum: d.datum,
      vimeo_url: i.vimeo_url || '', start: i.start_sec != null ? fmtStart(i.start_sec) : '', training_datum: i.training_datum || '',
      vimeo_meta: i.vimeo_id ? { titel: i.vimeo_titel, duur: i.duur, thumbnail: i.vimeo_thumbnail } : null,
      vimeo_bezig: false, vimeo_fout: null,
      wat_gebeurde: i.wat_gebeurde || '', notities: i.notities || '',
      trade_info: { paar: t.paar || '', richting: t.richting || '', uitleg: t.uitleg || '', resultaat_r: t.resultaat_r == null ? '' : String(t.resultaat_r).replace('.', ',') },
      gekozen_asset_ids: Array.isArray(i.gekozen_asset_ids) ? i.gekozen_asset_ids.slice() : [],
      kanalen: Array.isArray(i.kanalen) && i.kanalen.length ? i.kanalen.slice() : KANALEN.map((k) => k[0]),
    };
    st.dropAssets = assets;
    st.bezig = [];
  }

  const nl = (n) => (n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n));
  function cijferCel(d) {
    const c = st.lijst.cijfers && st.lijst.cijfers[d.slug];
    if (!c) return `<span style="color:var(--text-3)">${d.status === 'gepubliceerd' ? '0 · 0 · 0' : '—'}</span>`;
    const top = (c.top_blokken || []).map((b) => b.type).join(' · ');
    return `${nl(c.bezoekers)} · <b>${nl(c.leads)}</b> · ${nl(c.calls)}${c.bezoekers ? `<div style="color:var(--text-3);font-size:11px">${String(c.conversie_pct).replace('.', ',')}% conversie</div>` : ''}${top ? `<div style="color:var(--text-3);font-size:11px" title="Meest gebruikte blokken">▲ ${esc(top)}</div>` : ''}`;
  }

  const NB_LABEL = { concept: ['accent', 'In GHL'], test_verstuurd: ['accent', 'Test verstuurd'], ingepland: ['warn', 'Ingepland'], verstuurd: ['ok', 'Verstuurd'] };
  const LANC_LABEL = { ingepland: ['warn', 'Ingepland'], taggen: ['accent', 'Wordt verstuurd'], klaar: ['ok', 'Verstuurd'], geannuleerd: ['neutral', 'Geannuleerd'], mislukt: ['danger', 'Mislukt'] };
  function nbCel(d) {
    const lz = d.lancering;
    if (lz) {
      const [c, l] = LANC_LABEL[lz.status] || ['neutral', lz.status];
      const extra = lz.status === 'ingepland' ? fmtTijd(lz.ingepland_op) : lz.totaal != null ? `${nl(lz.getagd)} van ${nl(lz.totaal)}` : '';
      return pill(c, l) + (extra ? `<div style="color:var(--text-3);font-size:11px">${esc(extra)}</div>` : '');
    }
    const n = d.nieuwsbrief;
    if (!n) return '<span style="color:var(--text-3)">—</span>';
    const [c, l] = NB_LABEL[n.status] || ['neutral', n.status];
    const s = n.stats || {};
    const cijfers = s.geopend != null || s.geklikt != null ? `<div style="color:var(--text-3);font-size:11px">${s.geopend != null ? nl(s.geopend) + ' open' : ''}${s.geklikt != null ? ' · ' + nl(s.geklikt) + ' klik' : ''}</div>` : '';
    return pill(c, l) + cijfers;
  }

  function overzichtHtml() {
    const L = st.lijst;
    const kop = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:18px;font-weight:700">Contentmachine</div>
      <div style="color:var(--text-3);font-size:12.5px">Elke week één drop: webpagina, nieuwsbrief, stories, Instagram-post en LinkedIn — uit wat er die week gebeurde.</div></div>
      <div style="display:flex;gap:8px"><button class="btn btn-ghost btn-sm" onclick="__cmVernieuw()">${L.loading ? 'Laden…' : 'Vernieuwen'}</button>
      <button class="btn btn-primary" onclick="__cmNieuw()">+ Nieuwe drop</button></div></div>`;
    if (L.error) {
      return `${kop}<div class="card"><div class="card-body" style="color:${L.migratie ? 'var(--amber)' : 'var(--rose)'}">${esc(L.error)}
        <div style="margin-top:8px"><button class="btn btn-sm" onclick="__cmVernieuw()">Opnieuw proberen</button></div></div></div>`;
    }
    if (!L.fetched) return `${kop}<div style="color:var(--text-3);font-size:12.5px">Drops laden…</div>`;
    if (!L.drops.length) {
      return `${kop}<div class="card"><div class="card-body" style="text-align:center;padding:30px 18px">
        <div style="font-size:14px;font-weight:600;margin-bottom:4px">Nog geen drops</div>
        <div style="color:var(--text-3);font-size:12.5px;max-width:480px;margin:0 auto 12px">Klik op <b>Nieuwe drop</b>: plak eventueel de Vimeo-link van de training, vertel wat er deze week gebeurde en sleep er foto's bij. De rest maakt de machine.</div>
        <button class="btn btn-primary" onclick="__cmNieuw()">+ Nieuwe drop</button></div></div>`;
    }
    const th = 'padding:10px 12px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:600;border-bottom:1px solid var(--border);white-space:nowrap;text-align:left';
    const td = 'padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle';
    const rijen = L.drops.map((d) => {
      const [c, l] = STATUS[d.status] || ['neutral', d.status];
      const titel = d.titel || d.kernidee || d.wat_gebeurde_kort || '—';
      return `<tr role="button" tabindex="0" style="cursor:pointer" onclick="__cmOpen('${esc(d.id)}')" onkeydown="__cmOpenToets(event,'${esc(d.id)}')">
        <td style="${td};white-space:nowrap"><b style="font-family:var(--mono,monospace)">${esc(d.slug)}</b><div style="color:var(--text-3);font-size:11.5px">${esc(fmtDag(d.datum))}</div></td>
        <td style="${td}">${pill(c, l)}</td>
        <td class="cm-mob-weg" style="${td}">${d.soort === 'training' ? pill('accent', 'Training') : pill('neutral', 'Update')}</td>
        <td class="cm-mob-weg" style="${td}">${d.format_key ? esc(FORMATS[d.format_key] || d.format_key) : '<span style="color:var(--text-3)">—</span>'}${d.weekeditie ? `<div style="margin-top:3px">${pill('ok', 'Weekeditie · ' + (d.thema || ''))}</div>` : ''}</td>
        <td style="${td};max-width:420px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(titel)}</div></td>
        <td class="cm-mob-weg" style="${td};text-align:right;font-variant-numeric:tabular-nums" title="bezoekers · leads · calls, conversie en de meest gebruikte blokken">${cijferCel(d)}</td>
        <td class="cm-mob-weg" style="${td};white-space:nowrap">${nbCel(d)}</td>
        <td class="cm-mob-weg" style="${td};white-space:nowrap;color:var(--text-3);font-size:12px">${esc(fmtTijd(d.gewijzigd_op))}</td>
      </tr>`;
    }).join('');
    return `${kop}<div class="card cm-tabel" style="overflow:hidden"><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr><th style="${th}">Drop</th><th style="${th}">Status</th><th class="cm-mob-weg" style="${th}">Soort</th><th class="cm-mob-weg" style="${th}">Format</th><th style="${th}">Titel / kernidee</th><th class="cm-mob-weg" style="${th};text-align:right">Bezoekers · leads · calls</th><th class="cm-mob-weg" style="${th}">Nieuwsbrief</th><th class="cm-mob-weg" style="${th}">Gewijzigd</th></tr></thead>
      <tbody>${rijen}</tbody></table></div></div>
      <div style="font-size:11.5px;color:var(--text-3);margin-top:8px">Klik op een drop om hem te openen. Bezoekers, leads, calls en per kanaal: zelfde bron als Groei → Trainingdrops; ▲ = de meest gebruikte blokken van de Weekeditie.</div>`;
  }

  // ── Nieuwe drop: invoer ───────────────────────────────────────────────────
  const F = () => st.form;
  window.__cmVeld = (pad, waarde) => {
    const delen = pad.split('.');
    let o = st.form;
    for (let i = 0; i < delen.length - 1; i++) o = o[delen[i]];
    o[delen[delen.length - 1]] = waarde;
    if (pad === 'datum') { const el = document.getElementById('cm-slug'); if (el) el.textContent = slugVan(waarde); }
    if (pad === 'training_datum') st.form.training_datum_uit_titel = false;
  };
  window.__cmKanaal = (k, aan) => {
    const set = new Set(F().kanalen);
    if (aan) set.add(k); else set.delete(k);
    F().kanalen = KANALEN.map((x) => x[0]).filter((x) => set.has(x));
  };

  window.__cmVimeo = async (url) => {
    const f = F();
    f.vimeo_url = String(url || '').trim();
    f.vimeo_meta = null; f.vimeo_fout = null;
    if (!f.vimeo_url) { teken('cm-vimeo-info', vimeoInfoHtml()); return; }
    f.vimeo_bezig = true; teken('cm-vimeo-info', vimeoInfoHtml());
    try {
      const j = await post('/api/contentmachine/drops', { actie: 'vimeo', url: f.vimeo_url });
      if (!j.ok) f.vimeo_fout = j.fout || 'Geen geldige Vimeo-link.';
      else {
        f.vimeo_meta = { titel: j.titel, duur: j.duur, thumbnail: j.thumbnail, waarschuwing: j.waarschuwing || null }; f.vimeo_url = j.vimeo_url;
        if (!f.training_datum && j.training_datum) { f.training_datum = j.training_datum; f.training_datum_uit_titel = true; }
      }
    } catch (e) { f.vimeo_fout = foutTekst(e, 'Vimeo-link controleren mislukt.'); }
    f.vimeo_bezig = false; teken('cm-vimeo-info', vimeoInfoHtml());
  };

  function vimeoInfoHtml() {
    const f = F();
    if (f.vimeo_bezig) return '<span style="color:var(--text-3);font-size:12px">Vimeo controleren…</span>';
    if (f.vimeo_fout) return `<span style="color:var(--rose);font-size:12px">${esc(f.vimeo_fout)}</span>`;
    if (!f.vimeo_url) return '<span style="color:var(--text-3);font-size:12px">Geen video deze week? Laat leeg — dan wordt het een <b>update</b>-drop (verhaal, beelden, trade).</span>';
    const m = f.vimeo_meta || {};
    return `<div style="display:flex;gap:10px;align-items:center">${m.thumbnail ? `<img src="${esc(m.thumbnail)}" alt="" style="width:96px;height:54px;object-fit:cover;border-radius:6px;border:1px solid var(--border)">` : ''}
      <div style="font-size:12.5px"><b>${esc(m.titel || 'Vimeo-video')}</b>${m.duur ? ` · ${esc(fmtDuur(m.duur))}` : ''}<div style="color:var(--text-3);font-size:11.5px">Soort: training (formulier → video ontgrendelt → cadeau)</div>
      ${m.waarschuwing ? `<div style="color:var(--amber);font-size:11.5px">${esc(m.waarschuwing)}</div>` : ''}</div></div>
      <label class="tk-field" style="margin-top:10px;max-width:420px"><span class="tk-field-l">Datum training</span>
        <input type="date" class="ib-input" value="${esc(f.training_datum || '')}" oninput="__cmVeld('training_datum',this.value)">
        <span style="color:${f.training_datum ? 'var(--text-3)' : 'var(--amber)'};font-size:11.5px">${f.training_datum
          ? (f.training_datum_uit_titel ? 'Uit de Vimeo-titel gehaald — klopt het?' : 'De teksten noemen enkel deze dag.')
          : 'Vul in wanneer de live training was. Zonder datum noemt de machine geen dag.'}</span></label>`;
  }

  function invoerData() {
    const f = F();
    return {
      vimeo_url: f.vimeo_url, start: f.start, training_datum: f.training_datum || null,
      vimeo_meta: f.vimeo_meta ? { titel: f.vimeo_meta.titel, duur: f.vimeo_meta.duur, thumbnail: f.vimeo_meta.thumbnail } : null,
      wat_gebeurde: f.wat_gebeurde, trade_info: f.trade_info, notities: f.notities,
      gekozen_asset_ids: f.gekozen_asset_ids, kanalen: f.kanalen,
    };
  }

  /** Bewaar het formulier; maakt de concept-drop aan als die er nog niet is. */
  async function bewaar(stil) {
    const f = F();
    if (st.bewaren) return f.id;
    st.bewaren = true;
    try {
      let j;
      if (!f.id) j = await post('/api/contentmachine/drops', { actie: 'maak', datum: f.datum, input: invoerData() });
      else j = await post('/api/contentmachine/drops', { actie: 'bewaar', id: f.id, datum: f.datum, input: invoerData() });
      f.id = j.drop.id; f.slug = j.drop.slug; f.status = j.drop.status; f.datum = j.drop.datum;
      const el = document.getElementById('cm-slug'); if (el) el.textContent = f.slug;
      st.lijst.fetched = false;
      if (!stil) toast('Concept bewaard (' + f.slug + ').');
      return f.id;
    } catch (e) {
      toast(foutTekst(e, 'Bewaren mislukt.'));
      throw e;
    } finally { st.bewaren = false; }
  }
  window.__cmBewaar = () => bewaar(false).catch(() => {});
  window.__cmGenereer = async () => {
    const f = F();
    if (!f.wat_gebeurde.trim() && !f.vimeo_url && !st.dropAssets.length) { toast('Vul minstens in wat er deze week gebeurde, een Vimeo-link of een foto.'); return; }
    try { await bewaar(true); } catch (_) { return; }
    if (typeof window.__cmGenereerStart === 'function') { window.__cmGenereerStart(f.id); return; }
    toast('Concept bewaard. De generator wordt in de volgende fase gekoppeld.');
  };

  // ── Beelden opladen (drop én bibliotheek) ─────────────────────────────────
  const TOEGELATEN = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_ZIJDE = 2400;

  /** Grote of exotische beelden (HEIC …) verkleinen/omzetten in de browser. */
  async function voorbereid(file) {
    if (file.type === 'image/gif' && file.size <= 10 * 1024 * 1024) return file;
    let bmp = null;
    try { bmp = await createImageBitmap(file); } catch (_) { /* niet te lezen */ }
    if (!bmp) {
      if (TOEGELATEN.includes(file.type) && file.size <= 10 * 1024 * 1024) return file;
      throw new Error('Dit bestand kan de browser niet lezen (gebruik PNG, JPEG of WebP).');
    }
    const groot = Math.max(bmp.width, bmp.height);
    if (TOEGELATEN.includes(file.type) && groot <= MAX_ZIJDE && file.size <= 6 * 1024 * 1024) return file;
    const f = Math.min(1, MAX_ZIJDE / groot);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * f); c.height = Math.round(bmp.height * f);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const naar = (type, q) => new Promise((ok) => c.toBlob(ok, type, q));
    let blob = file.type === 'image/png' ? await naar('image/png') : null;
    if (!blob || blob.size > 8 * 1024 * 1024) blob = await naar('image/jpeg', 0.9);
    if (!blob) throw new Error('Omzetten mislukt.');
    return blob;
  }

  /** Eén bestand: voorbereiden → signed upload → registreren → AI-beschrijving. */
  async function laadOp(file, { dropId, slug, extra }, melder) {
    melder('voorbereiden');
    const blob = await voorbereid(file);
    const type = blob.type || file.type;
    const u = await post('/api/contentmachine/assets', { actie: 'upload-url', content_type: type, slug });
    melder('opladen');
    await window._authSharedReady;
    if (!window.supabase || !window.supabase.storage) throw new Error('Storage-verbinding niet beschikbaar.');
    const up = await window.supabase.storage.from(u.bucket || 'content').uploadToSignedUrl(u.pad, u.token, blob, { contentType: type });
    if (up.error) throw new Error(up.error.message || 'Opladen mislukt.');
    melder('registreren');
    const r = await post('/api/contentmachine/assets', { actie: 'registreer', pad: u.pad, drop_id: dropId || null, ...(extra || {}) });
    return r.asset;
  }

  async function beschrijf(asset) {
    try {
      const r = await post('/api/contentmachine/assets', { actie: 'beschrijf', id: asset.id });
      return r.asset;
    } catch (e) {
      console.error('[contentmachine-v2] beschrijven mislukt:', e && e.status, e && (e.body || e.message));
      return Object.assign({}, asset, { _beschrijfFout: foutTekst(e, 'AI-beschrijving mislukt.') });
    }
  }

  window.__cmDropBestanden = async (files) => {
    const lijst = Array.from(files || []).filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (!lijst.length) { toast('Alleen beelden (PNG, JPEG, WebP, GIF).'); return; }
    let id;
    try { id = await bewaar(true); } catch (_) { return; }
    const slug = F().slug;
    await Promise.all(lijst.map(async (file) => {
      const job = { tmp: Math.random().toString(36).slice(2), naam: file.name, fase: 'wachten', fout: null };
      st.bezig.push(job); teken('cm-uploads', uploadsHtml());
      try {
        let a = await laadOp(file, { dropId: id, slug }, (fase) => { job.fase = fase; teken('cm-uploads', uploadsHtml()); });
        st.dropAssets.push(a); job.fase = 'ai';
        teken('cm-uploads', uploadsHtml());
        a = await beschrijf(a);
        st.dropAssets = st.dropAssets.map((x) => (x.id === a.id ? a : x));
        st.bezig = st.bezig.filter((x) => x !== job);
      } catch (e) {
        job.fase = 'fout'; job.fout = e && e.message ? e.message : 'Mislukt';
        console.error('[contentmachine-v2] upload mislukt:', file.name, e);
      }
      teken('cm-uploads', uploadsHtml());
    }));
  };

  function sleepZone(id, handler, tekst) {
    return `<label class="cm-zone" ondragover="event.preventDefault();this.classList.add('cm-zone-over')" ondragleave="this.classList.remove('cm-zone-over')"
        ondrop="event.preventDefault();this.classList.remove('cm-zone-over');${handler}(event.dataTransfer.files)">
      <input type="file" id="${id}" accept="image/*,.heic,.heif" multiple style="display:none" onchange="${handler}(this.files);this.value=''">
      <div style="font-weight:600;font-size:13px">${tekst}</div>
      <div style="color:var(--text-3);font-size:11.5px">Sleep beelden hierheen of klik — PNG, JPEG, WebP, GIF (grote foto's worden verkleind). De AI beschrijft elk beeld.</div></label>`;
  }

  const FASE = { wachten: 'wacht…', voorbereiden: 'voorbereiden…', opladen: 'opladen…', registreren: 'controleren…', ai: 'AI beschrijft…', fout: 'mislukt' };

  function assetKaart(a, { bib } = {}) {
    const fn = bib ? '__cmBibVeld' : '__cmAssetVeld';
    const ai = a.ai_details || {};
    const feiten = [ai.firma, ai.bedrag != null ? (ai.valuta ? ai.valuta + ' ' : '') + new Intl.NumberFormat('nl-NL').format(ai.bedrag) : null, ai.paar, ai.timeframe, ai.richting].filter(Boolean);
    const naamZonder = a.persoon_naam && !a.toestemming_publiek;
    return `<div class="cm-asset" data-id="${esc(a.id)}">
      <a href="${esc(a.publieke_url)}" target="_blank" rel="noopener" class="cm-thumb"><img src="${esc(a.publieke_url)}" alt="${esc(a.bijschrift || '')}" loading="lazy"></a>
      <div class="cm-asset-body">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          <select class="ib-input cm-mini" onchange="${fn}('${esc(a.id)}','soort',this.value)">${SOORTEN.map(([v, l]) => `<option value="${v}" ${a.soort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${a.breedte ? `<span style="color:var(--text-3);font-size:11px">${a.breedte}×${a.hoogte}</span>` : ''}
          ${naamZonder ? pill('warn', 'naam niet publiek', 'Zonder toestemming wordt de naam nooit getoond') : ''}
        </div>
        ${a.ai_beschrijving ? `<div style="font-size:12px;color:var(--text-2);margin-bottom:6px">${esc(a.ai_beschrijving)}${feiten.length ? `<div style="color:var(--text-3);font-size:11px;margin-top:2px">${esc(feiten.join(' · '))}</div>` : ''}</div>`
          : a._beschrijfFout ? `<div style="font-size:11.5px;color:var(--amber);margin-bottom:6px">${esc(a._beschrijfFout)} <a href="javascript:void(0)" onclick="__cmBeschrijf('${esc(a.id)}',${bib ? 'true' : 'false'})">opnieuw</a></div>`
          : `<div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">Nog geen AI-beschrijving · <a href="javascript:void(0)" onclick="__cmBeschrijf('${esc(a.id)}',${bib ? 'true' : 'false'})">laat beschrijven</a></div>`}
        <input class="ib-input cm-mini" placeholder="Bijschrift" value="${esc(a.bijschrift || '')}" onchange="${fn}('${esc(a.id)}','bijschrift',this.value)" style="margin-bottom:6px">
        <div style="display:flex;gap:6px;align-items:center">
          <input class="ib-input cm-mini" placeholder="Persoon (bv. Leslie)" value="${esc(a.persoon_naam || '')}" onchange="${fn}('${esc(a.id)}','persoon_naam',this.value)" style="flex:1">
          <label style="font-size:11.5px;display:inline-flex;gap:4px;align-items:center;white-space:nowrap" title="Studentresultaten enkel met toestemming publiek"><input type="checkbox" ${a.toestemming_publiek ? 'checked' : ''} onchange="${fn}('${esc(a.id)}','toestemming_publiek',this.checked)"> toestemming</label>
        </div>
        ${bib ? `<input class="ib-input cm-mini" placeholder="tags, komma-gescheiden" value="${esc((a.tags || []).join(', '))}" onchange="${fn}('${esc(a.id)}','tags',this.value)" style="margin-top:6px">` : ''}
        <div style="display:flex;gap:10px;margin-top:6px;font-size:11.5px">
          ${!bib ? `<a href="javascript:void(0)" onclick="__cmNaarBib('${esc(a.id)}')" title="Ook later hergebruiken">→ bibliotheek</a>` : ''}
          <a href="javascript:void(0)" style="color:var(--rose)" onclick="__cmVerwijder('${esc(a.id)}',${bib ? 'true' : 'false'})">verwijderen</a>
        </div>
      </div></div>`;
  }

  function uploadsHtml() {
    const kaarten = st.dropAssets.map((a) => assetKaart(a)).join('');
    const jobs = st.bezig.map((j) => `<div class="cm-asset cm-job"><div class="cm-thumb cm-thumb-leeg">${j.fase === 'fout' ? '!' : '…'}</div>
      <div class="cm-asset-body"><div style="font-size:12.5px;font-weight:600;word-break:break-all">${esc(j.naam)}</div>
      <div style="font-size:11.5px;color:${j.fase === 'fout' ? 'var(--rose)' : 'var(--text-3)'}">${esc(j.fout || FASE[j.fase] || j.fase)}</div></div></div>`).join('');
    if (!kaarten && !jobs) return '';
    return `<div class="cm-grid">${kaarten}${jobs}</div>`;
  }

  async function assetPatch(id, veld, waarde, lijstNaam) {
    try {
      const r = await post('/api/contentmachine/assets', { actie: 'bijwerken', id, [veld]: waarde });
      if (lijstNaam === 'drop') st.dropAssets = st.dropAssets.map((x) => (x.id === id ? r.asset : x));
      else st.bib.assets = st.bib.assets.map((x) => (x.id === id ? r.asset : x));
      if (veld === 'toestemming_publiek' || veld === 'persoon_naam') teken(lijstNaam === 'drop' ? 'cm-uploads' : 'cm-bib-grid', lijstNaam === 'drop' ? uploadsHtml() : bibGridHtml());
    } catch (e) { toast(foutTekst(e, 'Opslaan mislukt.')); }
  }
  window.__cmAssetVeld = (id, veld, waarde) => assetPatch(id, veld, waarde, 'drop');
  window.__cmBibVeld = (id, veld, waarde) => assetPatch(id, veld, waarde, 'bib');
  window.__cmBeschrijf = async (id, bib) => {
    const lijst = bib ? st.bib.assets : st.dropAssets;
    const a = lijst.find((x) => x.id === id);
    if (!a) return;
    toast('AI beschrijft het beeld…');
    const nieuw = await beschrijf(a);
    if (bib) { st.bib.assets = st.bib.assets.map((x) => (x.id === id ? nieuw : x)); teken('cm-bib-grid', bibGridHtml()); }
    else { st.dropAssets = st.dropAssets.map((x) => (x.id === id ? nieuw : x)); teken('cm-uploads', uploadsHtml()); }
  };
  window.__cmNaarBib = async (id) => {
    try {
      const r = await post('/api/contentmachine/assets', { actie: 'naar-bibliotheek', id });
      st.dropAssets = st.dropAssets.filter((x) => x.id !== id);
      if (!F().gekozen_asset_ids.includes(id)) F().gekozen_asset_ids.push(id);
      st.bib.assets = [r.asset, ...st.bib.assets.filter((x) => x.id !== id)];
      toast('In de bibliotheek gezet (en gekozen voor deze drop).');
      rerender();
    } catch (e) { toast(foutTekst(e, 'Mislukt.')); }
  };
  window.__cmVerwijder = async (id, bib) => {
    if (!window.confirm('Dit beeld verwijderen?')) return;
    try {
      await post('/api/contentmachine/assets', { actie: 'verwijder', id });
      if (bib) { st.bib.assets = st.bib.assets.filter((x) => x.id !== id); teken('cm-bib-grid', bibGridHtml()); }
      else { st.dropAssets = st.dropAssets.filter((x) => x.id !== id); teken('cm-uploads', uploadsHtml()); }
      F().gekozen_asset_ids = F().gekozen_asset_ids.filter((x) => x !== id);
    } catch (e) { toast(foutTekst(e, 'Verwijderen mislukt.')); }
  };

  // ── Bibliotheek (gedeeld door de kiezer en het tabblad) ───────────────────
  async function laadBib(force) {
    const B = st.bib;
    if (B.loading || (B.fetched && !force)) return;
    B.loading = true; B.error = null;
    try {
      const j = await api('/api/contentmachine/assets?bibliotheek=1');
      B.assets = Array.isArray(j.assets) ? j.assets : [];
    } catch (e) {
      B.error = foutTekst(e, 'Kon de bibliotheek niet laden');
      console.error('[contentmachine-v2] bibliotheek laden mislukt:', e && e.status, e && (e.body || e.message));
    }
    B.loading = false; B.fetched = true;
    teken('cm-kiezer', kiezerHtml());
    teken('cm-bib-grid', bibGridHtml());
  }

  window.__cmKies = (id) => {
    const f = F();
    f.gekozen_asset_ids = f.gekozen_asset_ids.includes(id) ? f.gekozen_asset_ids.filter((x) => x !== id) : [...f.gekozen_asset_ids, id];
    teken('cm-kiezer', kiezerHtml());
  };
  window.__cmKiezerFilter = (v) => { st.kiezerFilter = v; teken('cm-kiezer', kiezerHtml()); };

  function filterChips(huidig, fn) {
    const items = [['all', 'Alles'], ...SOORTEN];
    return items.map(([v, l]) => `<button class="btn btn-sm ${huidig === v ? 'btn-primary' : 'btn-ghost'}" style="padding:3px 9px;font-size:11.5px" onclick="${fn}('${v}')">${l}</button>`).join('');
  }

  function kiezerHtml() {
    const B = st.bib;
    if (B.error) return `<div style="color:var(--rose);font-size:12px">${esc(B.error)}</div>`;
    if (!B.fetched) return '<div style="color:var(--text-3);font-size:12px">Bibliotheek laden…</div>';
    if (!B.assets.length) return '<div style="color:var(--text-3);font-size:12px">De bibliotheek is nog leeg — zie het tabblad Bibliotheek (masterclass-beelden laden).</div>';
    const f = F();
    const lijst = B.assets.filter((a) => st.kiezerFilter === 'all' || a.soort === st.kiezerFilter);
    const n = f.gekozen_asset_ids.length;
    return `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">${filterChips(st.kiezerFilter, '__cmKiezerFilter')}</div>
      <div class="cm-kies-grid">${lijst.map((a) => {
        const aan = f.gekozen_asset_ids.includes(a.id);
        return `<button type="button" class="cm-kies ${aan ? 'cm-kies-aan' : ''}" onclick="__cmKies('${esc(a.id)}')" title="${esc(a.bijschrift || SOORT_LABEL[a.soort] || '')}">
          <img src="${esc(a.publieke_url)}" alt="" loading="lazy"><span class="cm-kies-label">${esc(SOORT_LABEL[a.soort] || a.soort)}${a.persoon_naam ? ' · ' + esc(a.persoon_naam) : ''}</span>${aan ? '<span class="cm-kies-vink">✓</span>' : ''}</button>`;
      }).join('')}</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-top:6px">${n ? `<b>${n}</b> gekozen.` : 'Niets gekozen: de generator kiest er zelf bij (minst recent gebruikt eerst).'}</div>`;
  }

  function invoerHtml() {
    const f = F();
    const t = f.trade_info;
    const bewerkbaar = ['concept', 'gegenereerd', 'goedgekeurd'].includes(f.status);
    if (!st.bib.fetched && !st.bib.loading) queueMicrotask(() => laadBib(false));
    const kop = `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:18px;font-weight:700">${f.id ? 'Drop <span id="cm-slug" style="font-family:var(--mono,monospace)">' + esc(f.slug) + '</span>' : 'Nieuwe drop <span style="color:var(--text-3);font-weight:500">· <span id="cm-slug" style="font-family:var(--mono,monospace)">' + esc(slugVan(f.datum)) + '</span></span>'}</div>
      <div style="color:var(--text-3);font-size:12.5px">${f.id ? 'Status: ' + esc((STATUS[f.status] || [0, f.status])[1]) + ' · wijzigingen bewaar je met <b>Bewaar concept</b>.' : 'Zo kort mogelijk: wat je invult wordt webpagina, nieuwsbrief, stories, post en LinkedIn.'}</div></div>
      <div style="display:flex;gap:8px">${f.id ? '<button class="btn btn-ghost btn-sm" onclick="__cmNieuw()">+ Nog een nieuwe</button>' : ''}<button class="btn btn-sm" onclick="DFO.goTab(\'Overzicht\')">← Overzicht</button></div></div>`;
    if (!bewerkbaar) {
      return `${kop}<div class="card"><div class="card-body" style="font-size:12.5px;color:var(--text-2)">Deze drop is ${esc((STATUS[f.status] || [0, f.status])[1].toLowerCase())} en kan je hier niet meer aanpassen.</div></div>`;
    }
    const spraak = ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)
      ? `<button type="button" class="btn btn-ghost btn-sm" id="cm-mic" onclick="__cmSpraak()" title="Inspreken (nl-BE)">🎙 Inspreken</button>` : '';
    return `${kop}
    <div class="cm-kolommen">
      <div>
        <div class="card" style="margin-bottom:12px"><div class="card-body cm-velden">
          <div class="tk-field-row" style="grid-template-columns:160px 1fr 110px">
            <label class="tk-field"><span class="tk-field-l">Datum</span><input type="date" class="ib-input" value="${esc(f.datum)}" ${f.id && f.status !== 'concept' ? 'disabled' : ''} oninput="__cmVeld('datum',this.value)"></label>
            <label class="tk-field"><span class="tk-field-l">Vimeo-link (optioneel)</span><input class="ib-input" placeholder="https://vimeo.com/… of player.vimeo.com/video/…?h=…" value="${esc(f.vimeo_url)}" onchange="__cmVimeo(this.value)"></label>
            <label class="tk-field"><span class="tk-field-l">Start op (mm:ss)</span><input class="ib-input" placeholder="10:00" value="${esc(f.start)}" oninput="__cmVeld('start',this.value)"></label>
          </div>
          <div id="cm-vimeo-info" style="margin-top:8px">${vimeoInfoHtml()}</div>
        </div></div>

        <div class="card" style="margin-bottom:12px"><div class="card-body cm-velden">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
            <span class="tk-field-l" style="font-size:13px;font-weight:600;color:var(--text)">Wat is er deze week gebeurd?</span>${spraak}</div>
          <textarea id="cm-wat" class="ib-input" style="min-height:170px" placeholder="Payouts, een trade die genomen werd, een les uit de live, een moment uit de community… typ of plak, zo ruw als je wil." oninput="__cmVeld('wat_gebeurde',this.value)">${esc(f.wat_gebeurde)}</textarea>
          <details style="margin-top:12px" ${t.paar || t.uitleg ? 'open' : ''}><summary style="cursor:pointer;font-size:12.5px;font-weight:600">Trade van de week (optioneel)</summary>
            <div class="tk-field-row" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px">
              <label class="tk-field"><span class="tk-field-l">Paar</span><input class="ib-input" placeholder="EURUSD" value="${esc(t.paar)}" oninput="__cmVeld('trade_info.paar',this.value)"></label>
              <label class="tk-field"><span class="tk-field-l">Richting</span><select class="ib-input" onchange="__cmVeld('trade_info.richting',this.value)"><option value="">—</option><option value="long" ${t.richting === 'long' ? 'selected' : ''}>Long</option><option value="short" ${t.richting === 'short' ? 'selected' : ''}>Short</option></select></label>
              <label class="tk-field"><span class="tk-field-l">Resultaat (R)</span><input class="ib-input" placeholder="3,4" value="${esc(t.resultaat_r)}" oninput="__cmVeld('trade_info.resultaat_r',this.value)"></label>
            </div>
            <label class="tk-field" style="margin-top:8px"><span class="tk-field-l">Korte uitleg</span><textarea class="ib-input" placeholder="H4-context, impuls, 71%, 15M-bevestiging, entry, target…" oninput="__cmVeld('trade_info.uitleg',this.value)">${esc(t.uitleg)}</textarea></label>
          </details>
          <details style="margin-top:10px" ${f.notities ? 'open' : ''}><summary style="cursor:pointer;font-size:12.5px;font-weight:600">Notities voor de generator (optioneel)</summary>
            <textarea class="ib-input" style="margin-top:8px" placeholder="Bv. 'leg de nadruk op geduld', 'geen quiz deze week'…" oninput="__cmVeld('notities',this.value)">${esc(f.notities)}</textarea></details>
        </div></div>

        <div class="card" style="margin-bottom:12px"><div class="card-head"><div class="card-title">Foto's en screenshots van deze week</div></div><div class="card-body">
          ${sleepZone('cm-file', '__cmDropBestanden', "Payouts, trades, charts, teamfoto's…")}
          <div id="cm-uploads" style="margin-top:10px">${uploadsHtml()}</div>
        </div></div>
      </div>

      <div>
        <div class="card" style="margin-bottom:12px"><div class="card-head"><div class="card-title">Uit de bibliotheek</div></div><div class="card-body"><div id="cm-kiezer">${kiezerHtml()}</div></div></div>
        <div class="card" style="margin-bottom:12px"><div class="card-head"><div class="card-title">Kanalen</div></div><div class="card-body" style="display:flex;flex-wrap:wrap;gap:12px">
          ${KANALEN.map(([k, l]) => `<label style="font-size:12.5px;display:inline-flex;gap:6px;align-items:center"><input type="checkbox" ${f.kanalen.includes(k) ? 'checked' : ''} onchange="__cmKanaal('${k}',this.checked)"> ${l}</label>`).join('')}
        </div></div>
        <div class="card"><div class="card-body" style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" style="font-size:15px;padding:12px 16px;justify-content:center" onclick="__cmGenereer()">✨ ${f.status === 'concept' ? 'Genereer alles' : 'Genereer alles opnieuw'}</button>
          ${f.status !== 'concept' && f.id ? `<button class="btn btn-ghost btn-sm" style="justify-content:center" onclick="__cmWbOpen('${esc(f.id)}');DFO.goTab('Overzicht')">→ Naar het werkblad (zonder opnieuw te genereren)</button>` : ''}
          <button class="btn btn-ghost btn-sm" style="justify-content:center" onclick="__cmBewaar()">Bewaar concept</button>
          <div style="font-size:11.5px;color:var(--text-3)">Er wordt niets gepubliceerd of verstuurd: je krijgt eerst alles te zien en kan elk onderdeel aanpassen.${f.status !== 'concept' ? ' Opnieuw genereren maakt een nieuwe versie; de huidige blijft in de historiek.' : ''}</div>
        </div></div>
      </div>
    </div>`;
  }

  // Inspreken (Web Speech API): tekst wordt achteraan toegevoegd.
  let herkenning = null;
  window.__cmSpraak = () => {
    const knop = document.getElementById('cm-mic');
    if (herkenning) { herkenning.stop(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    herkenning = new SR();
    herkenning.lang = 'nl-BE'; herkenning.continuous = true; herkenning.interimResults = false;
    herkenning.onresult = (ev) => {
      let tekst = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) tekst += ev.results[i][0].transcript;
      if (!tekst) return;
      const f = F();
      f.wat_gebeurde = (f.wat_gebeurde ? f.wat_gebeurde.replace(/\s*$/, ' ') : '') + tekst.trim();
      const ta = document.getElementById('cm-wat'); if (ta) ta.value = f.wat_gebeurde;
    };
    herkenning.onend = () => { herkenning = null; const k = document.getElementById('cm-mic'); if (k) k.textContent = '🎙 Inspreken'; };
    herkenning.onerror = (e) => { toast('Inspreken: ' + (e.error || 'fout')); };
    herkenning.start();
    if (knop) knop.textContent = '■ Stop';
  };

  // ── Tabblad Bibliotheek ───────────────────────────────────────────────────
  window.__cmBibFilter = (v) => { st.bib.filter = v; teken('cm-bib-grid', bibGridHtml()); teken('cm-bib-chips', filterChips(v, '__cmBibFilter')); };
  window.__cmBibBestanden = async (files) => {
    const lijst = Array.from(files || []).filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (!lijst.length) { toast('Alleen beelden.'); return; }
    const soort = st.bib.filter !== 'all' ? st.bib.filter : undefined;
    await Promise.all(lijst.map(async (file) => {
      const job = { tmp: Math.random().toString(36).slice(2), naam: file.name, fase: 'wachten', fout: null };
      st.bib.bezig.push(job); teken('cm-bib-grid', bibGridHtml());
      try {
        let a = await laadOp(file, { dropId: null, slug: null, extra: soort ? { soort } : {} }, (fase) => { job.fase = fase; teken('cm-bib-grid', bibGridHtml()); });
        st.bib.assets = [a, ...st.bib.assets]; job.fase = 'ai'; teken('cm-bib-grid', bibGridHtml());
        a = await beschrijf(a);
        st.bib.assets = st.bib.assets.map((x) => (x.id === a.id ? a : x));
        st.bib.bezig = st.bib.bezig.filter((x) => x !== job);
      } catch (e) {
        job.fase = 'fout'; job.fout = e && e.message ? e.message : 'Mislukt';
        console.error('[contentmachine-v2] bibliotheek-upload mislukt:', file.name, e);
      }
      teken('cm-bib-grid', bibGridHtml());
    }));
  };
  window.__cmSeed = async () => {
    if (st.seed.bezig) return;
    st.seed.bezig = true; teken('cm-seed', seedHtml());
    try {
      st.seed.resultaat = await post('/api/contentmachine/assets', { actie: 'seed' });
      st.bib.fetched = false; await laadBib(true);
      toast(`Masterclass-beelden: ${st.seed.resultaat.nieuw} nieuw, ${st.seed.resultaat.al_aanwezig} stonden er al.`);
    } catch (e) { st.seed.resultaat = { ok: false, fout: foutTekst(e, 'Seed mislukt.') }; }
    st.seed.bezig = false; teken('cm-seed', seedHtml());
  };

  function seedHtml() {
    const r = st.seed.resultaat;
    const heeftSeed = st.bib.assets.some((a) => String(a.storage_path || '').startsWith('bibliotheek/seed/'));
    if (st.seed.bezig) return '<span style="font-size:12px;color:var(--text-3)">Masterclass-beelden opladen…</span>';
    const knop = `<button class="btn ${heeftSeed ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="__cmSeed()">${heeftSeed ? 'Masterclass-beelden aanvullen' : 'Masterclass-beelden laden (19)'}</button>`;
    const melding = r ? (r.ok === false ? `<span style="color:var(--rose);font-size:12px">${esc(r.fout)}</span>`
      : `<span style="font-size:12px;color:var(--text-3)">${r.nieuw} nieuw · ${r.al_aanwezig} al aanwezig${r.fouten && r.fouten.length ? ` · <span style="color:var(--rose)">${r.fouten.length} mislukt</span>` : ''}</span>`) : '';
    return `${knop} ${melding}`;
  }

  function bibGridHtml() {
    const B = st.bib;
    if (B.error) return `<div style="color:var(--rose);font-size:12.5px">${esc(B.error)}</div>`;
    if (!B.fetched) return '<div style="color:var(--text-3);font-size:12.5px">Bibliotheek laden…</div>';
    const lijst = B.assets.filter((a) => B.filter === 'all' || a.soort === B.filter);
    const jobs = B.bezig.map((j) => `<div class="cm-asset cm-job"><div class="cm-thumb cm-thumb-leeg">${j.fase === 'fout' ? '!' : '…'}</div>
      <div class="cm-asset-body"><div style="font-size:12.5px;font-weight:600;word-break:break-all">${esc(j.naam)}</div>
      <div style="font-size:11.5px;color:${j.fase === 'fout' ? 'var(--rose)' : 'var(--text-3)'}">${esc(j.fout || FASE[j.fase] || j.fase)}</div></div></div>`).join('');
    if (!lijst.length && !jobs) return `<div style="color:var(--text-3);font-size:12.5px;padding:10px 0">${B.assets.length ? 'Geen beelden van deze soort.' : 'Nog geen beelden in de bibliotheek.'}</div>`;
    return `<div class="cm-grid">${jobs}${lijst.map((a) => assetKaart(a, { bib: true })).join('')}</div>`;
  }

  function bibliotheekHtml() {
    const B = st.bib;
    if (!B.fetched && !B.loading) queueMicrotask(() => laadBib(false));
    const per = SOORTEN.map(([v, l]) => [l, B.assets.filter((a) => a.soort === v).length]).filter(([, n]) => n);
    return `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <div><div style="font-size:18px;font-weight:700">Bibliotheek</div>
      <div style="color:var(--text-3);font-size:12.5px">Vaste beelden voor de drops: masterclass-slides, payouts, teamfoto's. Studentnamen verschijnen enkel publiek met toestemming.</div>
      ${per.length ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${per.map(([l, n]) => `${esc(l)} ${n}`).join(' · ')}</div>` : ''}</div>
      <div id="cm-seed">${seedHtml()}</div></div>
      <div class="card" style="margin-bottom:12px"><div class="card-body">${sleepZone('cm-bib-file', '__cmBibBestanden', 'Beelden toevoegen aan de bibliotheek')}
        <div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Staat er hieronder een filter aan (bv. Payout), dan krijgen nieuwe beelden die soort.</div></div></div>
      <div id="cm-bib-chips" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">${filterChips(B.filter, '__cmBibFilter')}</div>
      <div id="cm-bib-grid">${bibGridHtml()}</div>`;
  }

  // ── Stijl ─────────────────────────────────────────────────────────────────
  const CSS = `<style>
    .cm-kolommen{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:12px;align-items:start}
    @media (max-width:980px){.cm-kolommen{grid-template-columns:1fr}}
    .cm-zone{display:block;border:2px dashed var(--border-strong,#C9D2DE);border-radius:10px;padding:18px;text-align:center;cursor:pointer;background:var(--surface-2,#F2F4F7);transition:border-color .12s,background .12s}
    .cm-zone:hover,.cm-zone-over{border-color:var(--m,#6D3FD4);background:color-mix(in srgb,var(--m,#6D3FD4) 6%,var(--surface-2,#F2F4F7))}
    .cm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
    .cm-asset{display:flex;gap:10px;border:1px solid var(--border);border-radius:10px;padding:8px;background:var(--surface,#fff)}
    .cm-thumb{flex:0 0 92px;height:92px;border-radius:8px;overflow:hidden;background:var(--surface-3,#E9EDF2);display:flex;align-items:center;justify-content:center}
    .cm-thumb img{width:100%;height:100%;object-fit:cover}
    .cm-thumb-leeg{font-size:22px;color:var(--text-3)}
    .cm-asset-body{flex:1;min-width:0}
    .ib-input.cm-mini{padding:5px 8px;font-size:12px;border-width:1px}
    select.ib-input.cm-mini{padding-right:26px;width:auto}
    .cm-kies-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:6px;max-height:380px;overflow:auto}
    .cm-kies{position:relative;border:2px solid transparent;border-radius:8px;padding:0;overflow:hidden;aspect-ratio:1;background:var(--surface-3,#E9EDF2);cursor:pointer}
    .cm-kies img{width:100%;height:100%;object-fit:cover;display:block}
    .cm-kies-aan{border-color:var(--m,#6D3FD4);box-shadow:0 0 0 2px color-mix(in srgb,var(--m,#6D3FD4) 30%,transparent)}
    .cm-kies-label{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);color:#fff;font-size:10px;padding:2px 4px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cm-kies-vink{position:absolute;top:4px;right:4px;background:var(--m,#6D3FD4);color:#fff;border-radius:50%;width:20px;height:20px;font-size:12px;display:flex;align-items:center;justify-content:center}
    @media (max-width:640px){.cm-tabel .cm-mob-weg{display:none}.cm-velden .tk-field-row{grid-template-columns:1fr!important}}
  </style>`;

  function overzichtView() {
    const W = window.__cmWerkblad;
    if (W && W.open && typeof window.__cmWerkbladView === 'function') return `<div class="pad">${CSS}${window.__cmWerkbladView()}</div>`;
    if (!st.lijst.fetched && !st.lijst.loading) queueMicrotask(() => laadLijst(false));
    return `<div class="pad">${CSS}${overzichtHtml()}</div>`;
  }
  function nieuweDropView() { return `<div class="pad">${CSS}${invoerHtml()}</div>`; }
  function bibliotheekView() { return `<div class="pad">${CSS}${bibliotheekHtml()}</div>`; }

  // Voor latere fasen (werkblad) en tests.
  window.__cmIntern = { st, rerender, teken, laadLijst, laadBib, bewaar, FORMATS, STATUS, KANALEN, esc, pill, fmtDag, fmtTijd, slugVan };

  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['contentmachine/Overzicht'] = overzichtView;
  window.DFO.VIEWS['contentmachine/Nieuwe drop'] = nieuweDropView;
  window.DFO.VIEWS['contentmachine/Bibliotheek'] = bibliotheekView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('contentmachine');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('contentmachine');
})();
