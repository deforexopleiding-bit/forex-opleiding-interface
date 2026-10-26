// modules/klanten-v2/views/contentmachine-weekeditie-v2.js
//
// Contentmachine 2.0 — de Pagina-tab van het werkblad voor een Weekeditie
// (output.pagina.blokken[]). Geladen na contentmachine-werkblad-v2.js en gebruikt
// diens hulpstukken (window.__cmWbHulp).
//
//   Links:  de regie (format, thema, hero, rode draad, motivatie van de regisseur)
//           en per blok: verplaatsen ↑↓, verwijderen ✕, opnieuw schrijven ↻ (met
//           instructie) en alle velden — getekend uit het JSON Schema van dat blok
//           (dezelfde schema's als de website: GET /api/contentmachine/drops?blokken=1).
//           Onderaan: blok toevoegen (de schrijver maakt het, op de gekozen plek).
//   Rechts: de ECHTE pagina in een iframe (website-preview op het voorbeeld-token,
//           niets gepubliceerd), gsm/desktop, verversen na bewaren.
(function () {
  'use strict';
  const PREVIEW = 'https://www.deforexopleiding.nl/training/voorbeeld/';
  const st = window.__cmWe = window.__cmWe || { blokken: null, laden: false, open: {}, toevoegType: '', toevoegPlek: null, bezig: null, instructie: {}, toestel: 'gsm', stempel: Date.now() };
  const H = () => window.__cmWbHulp;
  const wb = () => window.__cmWb;

  async function laadBlokken() {
    if (st.blokken || st.laden) return;
    st.laden = true;
    try { st.blokken = (await H().api('/api/contentmachine/drops?blokken=1')).blokken; }
    catch (e) { H().toast(H().foutTekst(e, 'Blokschema\'s laden mislukt.')); }
    st.laden = false; H().rerender();
  }
  const info = (t) => (st.blokken ? st.blokken.blokken.find((b) => b.type === t) : null);
  const NAAM = {
    hero: 'Hero', 'video-poort': 'Video-poort', 'replay-sweep-bos': 'Replay: sweep of break?', 'fib-animatie': 'Fib-animatie', trechter: 'Trechter',
    'rr-sliders': 'Winrate × R-sliders', 'funded-calculator': 'Funded-calculator', quiz: 'Quiz', 'trade-ontleed': 'Trade ontleed', 'payout-muur': 'Payout-muur',
    data: 'Data', fotostrip: 'Fotostrip', tip: 'Tip (flip)', 'mythe-feit': 'Mythe of feit', vooruitblik: 'Vooruitblik', citaat: 'Citaat', verhaal: 'Verhaal', cadeau: 'Cadeau', inschrijven: 'Inschrijven',
  };
  const CAT = { opening: ['accent', 'opening'], interactief: ['ok', 'interactief'], nugget: ['warn', 'nugget'], inhoud: ['neutral', 'inhoud'], conversie: ['accent', 'conversie'] };

  // ── velden uit het schema ─────────────────────────────────────────────────
  window.__cmWeTekstVeld = (pad, v) => { if (v === '') verwijderPad(pad); else H().zetPad(pad, v); H().markeer(); };
  window.__cmWeGetal = (pad, v) => { if (v === '' || v == null) verwijderPad(pad); else H().zetPad(pad, Number(String(v).replace(',', '.'))); H().markeer(); };
  window.__cmWeKeuze = (pad, v, num) => { if (v === '') verwijderPad(pad); else H().zetPad(pad, num ? Number(v) : v); H().markeer(); };
  window.__cmWeRegels = (pad, v) => { const l = String(v).split('\n').map((x) => x.trim()).filter(Boolean); if (l.length) H().zetPad(pad, l); else verwijderPad(pad); H().markeer(); };
  function verwijderPad(pad) {
    const delen = pad.split('.'); const laatste = delen.pop();
    const o = H().haal(delen.join('.'));
    if (o && typeof o === 'object') { if (Array.isArray(o)) o.splice(Number(laatste), 1); else delete o[laatste]; }
  }
  window.__cmWeItem = (pad, schemaPad, actie, i) => {
    const l = H().haal(pad);
    if (actie === 'nieuw') {
      const s = schemaOp(schemaPad);
      const item = leeg(s && s.items);
      if (Array.isArray(l)) l.push(item); else H().zetPad(pad, [item]);
    } else if (Array.isArray(l)) {
      if (actie === 'weg') l.splice(i, 1);
      if (actie === 'op' && i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]];
      if (actie === 'neer' && i < l.length - 1) [l[i + 1], l[i]] = [l[i], l[i + 1]];
    }
    window.__cmWb.dirty = true; H().rerender();
  };
  // schema's opzoeken via "type|props.payouts" (pad binnen het blokschema)
  function schemaOp(sleutel) {
    const [type, ...rest] = sleutel.split('|');
    let s = info(type) && info(type).schema;
    for (const k of rest.join('|').split('.').filter(Boolean)) s = s && (s.properties ? s.properties[k] : null);
    return s;
  }
  function leeg(s) {
    if (!s) return '';
    if (s.type === 'object') { const o = {}; for (const k of s.required || []) { const x = s.properties[k]; o[k] = x.type === 'number' || x.type === 'integer' ? (x.minimum || 0) : x.type === 'array' ? [] : x.enum ? x.enum[0] : ''; } return o; }
    return '';
  }

  function label(k, s, nodig) {
    const uitleg = s && s.description ? ` <span style="color:var(--text-3);font-weight:400" title="${H().esc(s.description)}">ⓘ</span>` : '';
    return `${H().esc(k.replace(/_/g, ' '))}${nodig ? '' : ' <span style="color:var(--text-3);font-weight:400">(optioneel)</span>'}${uitleg}`;
  }

  function velden(s, pad, sleutel, diepte = 0) {
    if (!s || !s.properties) return '';
    const nodig = new Set(s.required || []);
    return Object.entries(s.properties).map(([k, x]) => veldVoor(k, x, `${pad}.${k}`, `${sleutel}.${k}`, nodig.has(k), diepte)).join('');
  }

  function veldVoor(k, x, pad, sleutel, nodig, diepte) {
    const h = H(); const esc = h.esc;
    const v = h.haal(pad);
    const lab = label(k, x, nodig);
    if (/asset_id$/.test(k)) return h.beeldVeld(pad, k.replace(/_/g, ' '));
    if (x.enum && x.type !== 'object') {
      const num = x.type === 'number' || x.type === 'integer';
      return `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">${lab}</span><select class="ib-input cm-mini" onchange="__cmWeKeuze('${pad}',this.value,${num})">${nodig ? '' : '<option value="">—</option>'}${x.enum.map((o) => `<option value="${esc(o)}" ${String(v) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    }
    if (x.type === 'number' || x.type === 'integer') {
      const grens = [x.minimum != null ? 'min ' + x.minimum : '', x.maximum != null ? 'max ' + x.maximum : ''].filter(Boolean).join(' · ');
      return `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">${lab}${grens ? ` <span style="color:var(--text-3);font-weight:400">· ${grens}</span>` : ''}</span><input class="ib-input cm-mini" type="number" step="any" value="${v == null ? '' : esc(v)}" oninput="__cmWeGetal('${pad}',this.value)"></label>`;
    }
    if (x.type === 'string') {
      const lang = (x.maxLength || 0) > 160;
      const max = x.maxLength ? ` maxlength="${x.maxLength}"` : '';
      const tel = x.maxLength ? ` <span style="color:var(--text-3);font-weight:400">· ${String(v || '').length}/${x.maxLength}</span>` : '';
      const inv = lang
        ? `<textarea class="ib-input cm-mini" rows="${x.maxLength > 1000 ? 7 : 3}"${max} oninput="__cmWeTekstVeld('${pad}',this.value)">${esc(v || '')}</textarea>`
        : `<input class="ib-input cm-mini" value="${esc(v || '')}"${max} oninput="__cmWeTekstVeld('${pad}',this.value)">`;
      return `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">${lab}${tel}</span>${inv}</label>`;
    }
    if (x.type === 'array' && x.items && x.items.type === 'string') {
      return `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">${lab} <span style="color:var(--text-3);font-weight:400">· één per regel</span></span><textarea class="ib-input cm-mini" rows="3" oninput="__cmWeRegels('${pad}',this.value)">${esc((v || []).join('\n'))}</textarea></label>`;
    }
    if (x.type === 'array' && x.items && x.items.type === 'object') {
      const l = Array.isArray(v) ? v : [];
      const max = x.maxItems != null ? x.maxItems : 99;
      return `<div class="cm-we-lijst"><div class="tk-field-l" style="margin-bottom:4px">${lab} <span style="color:var(--text-3);font-weight:400">· ${l.length}${x.minItems ? ` (min ${x.minItems}` : ' ('}max ${max})</span></div>
        ${l.map((_, i) => `<div class="cm-wb-sub"><b style="font-size:11.5px">${i + 1}</b><span style="float:right;font-size:11.5px">
          ${i > 0 ? `<a href="javascript:void(0)" onclick="__cmWeItem('${pad}','${sleutel}','op',${i})">↑</a> ` : ''}${i < l.length - 1 ? `<a href="javascript:void(0)" onclick="__cmWeItem('${pad}','${sleutel}','neer',${i})">↓</a> ` : ''}
          <a href="javascript:void(0)" style="color:var(--rose)" onclick="__cmWeItem('${pad}','${sleutel}','weg',${i})">✕</a></span>
          ${velden(x.items, `${pad}.${i}`, `${sleutel}.items`, diepte + 1)}</div>`).join('')}
        ${l.length < max ? `<a href="javascript:void(0)" style="font-size:12px" onclick="__cmWeItem('${pad}','${sleutel.replace(/\.items/g, '')}','nieuw')">+ toevoegen</a>` : ''}</div>`;
    }
    if (x.type === 'object' && x.propertyNames && x.propertyNames.enum) {
      // partiële record (uitleg per fib-niveau): één veld per sleutel
      return `<div class="cm-wb-sub"><div class="tk-field-l">${lab}</div>${x.propertyNames.enum.map((sl) => veldVoor(sl, x.additionalProperties || { type: 'string' }, `${pad}.${sl}`, sleutel, false, diepte + 1)).join('')}</div>`;
    }
    if (x.type === 'object') {
      const aan = v && typeof v === 'object';
      return `<div class="cm-wb-sub"><div class="tk-field-l">${lab}${!nodig ? ` <a href="javascript:void(0)" style="font-weight:400;font-size:11.5px" onclick="__cmWeObject('${pad}','${sleutel}',${aan ? 0 : 1})">${aan ? 'weghalen' : '+ invullen'}</a>` : ''}</div>${aan || nodig ? velden(x, pad, sleutel, diepte + 1) : ''}</div>`;
    }
    return '';
  }
  window.__cmWeObject = (pad, sleutel, aan) => {
    if (aan) H().zetPad(pad, leeg(schemaOp(sleutel)));
    else verwijderPad(pad);
    window.__cmWb.dirty = true; H().rerender();
  };

  // ── blokacties ────────────────────────────────────────────────────────────
  window.__cmWeOpen = (i) => { st.open[i] = !st.open[i]; H().rerender(); };
  window.__cmWeVerplaats = (i, d) => {
    const l = wb().output.pagina.blokken; const j = i + d;
    if (j < 1 || j >= l.length || i < 1) return; // de hero blijft eerst
    [l[i], l[j]] = [l[j], l[i]]; wb().dirty = true; H().rerender();
  };
  window.__cmWeVerwijder = (i) => {
    const l = wb().output.pagina.blokken;
    if (i === 0) { H().toast('De hero blijft: schrijf hem opnieuw in plaats van te verwijderen.'); return; }
    if (!window.confirm(`Blok ${i + 1} (${NAAM[l[i].type] || l[i].type}) verwijderen?`)) return;
    l.splice(i, 1); wb().dirty = true; H().rerender();
  };
  window.__cmWeInstructie = (i, v) => { st.instructie[i] = v; };
  window.__cmWeThema = (v) => { H().zetPad('pagina.thema', v); wb().dirty = true; H().rerender(); };
  window.__cmWeHeroVariant = (v) => { H().zetPad('pagina.blokken.0.variant', v); wb().dirty = true; H().rerender(); };

  async function blokOpdracht(opdracht, bericht) {
    if (st.bezig) return;
    if (wb().dirty && !window.confirm('Niet-bewaarde wijzigingen gaan verloren. Doorgaan?')) return;
    st.bezig = opdracht.type ? 'nieuw' : 'blok' + opdracht.index; H().rerender();
    try {
      const r = await H().post('/api/contentmachine/genereer', { id: wb().drop.id, blok: opdracht });
      const versies = await H().api('/api/contentmachine/drops?id=' + encodeURIComponent(wb().drop.id)).then((x) => x.versies).catch(() => wb().versies);
      H().zet(r.drop, null, versies);
      st.stempel = Date.now();
      H().toast(bericht);
    } catch (e) {
      H().toast(H().foutTekst(e, 'Blok schrijven mislukt.'));
      console.error('[contentmachine-weekeditie] blok mislukt:', e && e.status, e && (e.body || e.message));
    }
    st.bezig = null; H().rerender();
  }
  window.__cmWeHerschrijf = (i) => blokOpdracht({ index: i, instructie: st.instructie[i] || '' }, `Blok ${i + 1} opnieuw geschreven.`);
  window.__cmWeToevoegType = (t) => { st.toevoegType = t; };
  window.__cmWeToevoegPlek = (p) => { st.toevoegPlek = Number(p); };
  window.__cmWeToevoegen = () => {
    if (!st.toevoegType) { H().toast('Kies eerst een bloktype.'); return; }
    const n = wb().output.pagina.blokken.length;
    const plek = st.toevoegPlek != null && st.toevoegPlek >= 1 && st.toevoegPlek <= n ? st.toevoegPlek : Math.max(1, n - 1);
    blokOpdracht({ index: plek, type: st.toevoegType, instructie: st.instructie.nieuw || '' }, `Blok ${NAAM[st.toevoegType]} toegevoegd.`);
  };

  // ── editor ────────────────────────────────────────────────────────────────
  function blokKaart(b, i, n) {
    const h = H(); const esc = h.esc;
    const inf = info(b.type);
    const [kl, cat] = CAT[inf ? inf.categorie : 'inhoud'] || ['neutral', ''];
    const open = !!st.open[i];
    const props = inf && inf.schema && inf.schema.properties && inf.schema.properties.props;
    const titel = b.props && (b.props.titel || b.props.vraag || b.props.voorkant || b.props.tekst || '');
    const bezig = st.bezig === 'blok' + i;
    return `<div class="cm-we-blok ${open ? 'open' : ''}">
      <div class="cm-we-kop" onclick="__cmWeOpen(${i})">
        <b class="cm-we-nr">${String(i + 1).padStart(2, '0')}</b>
        <div style="min-width:0;flex:1"><div style="font-weight:700;font-size:13px">${esc(NAAM[b.type] || b.type)}${b.variant ? ` <span style="font-weight:400;color:var(--text-3)">· ${esc(b.variant)}</span>` : ''} ${h.pill(kl, cat)}</div>
          <div class="cm-we-sam">${esc(String(titel).replace(/\*\*/g, '').slice(0, 110))}</div></div>
        <span class="cm-we-act" onclick="event.stopPropagation()">
          ${i > 1 ? `<a href="javascript:void(0)" title="Omhoog" onclick="__cmWeVerplaats(${i},-1)">↑</a>` : ''}
          ${i > 0 && i < n - 1 ? `<a href="javascript:void(0)" title="Omlaag" onclick="__cmWeVerplaats(${i},1)">↓</a>` : ''}
          ${i > 0 ? `<a href="javascript:void(0)" title="Verwijderen" style="color:var(--rose)" onclick="__cmWeVerwijder(${i})">✕</a>` : ''}
          <a href="javascript:void(0)" onclick="__cmWeOpen(${i})">${open ? '▴' : '▾'}</a></span>
      </div>
      ${open ? `<div class="cm-we-body">
        ${i === 0 && b.type === 'hero' ? `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">Hero-variant</span><select class="ib-input cm-mini" onchange="__cmWeHeroVariant(this.value)">${(st.blokken.hero_varianten || []).filter((v) => v !== 'video-poort' || (wb().drop.input || {}).vimeo_id).map((v) => `<option ${v === b.variant ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>` : ''}
        ${b.type === 'data' ? `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">Variant</span><select class="ib-input cm-mini" onchange="__cmWeKeuze('pagina.blokken.${i}.variant',this.value,false)"><option ${b.variant === 'een' ? 'selected' : ''}>een</option><option ${b.variant === 'drie' ? 'selected' : ''}>drie</option></select></label>` : ''}
        ${props ? velden(props, `pagina.blokken.${i}.props`, `${b.type}|props`) : ''}
        ${b.type === 'cadeau' ? '<div style="font-size:12px;color:var(--text-2)">Vaste tekst: gratis strategiesessie met Dave, t.w.v. €100, nu €0.</div>' : ''}
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <input class="ib-input cm-mini" style="flex:1;min-width:160px" placeholder="Instructie (optioneel): korter, andere invalshoek…" value="${esc(st.instructie[i] || '')}" oninput="__cmWeInstructie(${i},this.value)">
          <button class="btn btn-sm" onclick="__cmWeHerschrijf(${i})" ${st.bezig ? 'disabled' : ''}>${bezig ? 'Bezig…' : '↻ Opnieuw schrijven'}</button></div>
      </div>` : ''}
    </div>`;
  }

  window.__cmWeEditor = function () {
    laadBlokken();
    const h = H(); const esc = h.esc;
    if (!st.blokken) return '<div style="color:var(--text-3);font-size:12px">Blokschema\'s laden…</div>';
    const o = wb().output; const p = o.pagina; const r = o.regie || {};
    const n = p.blokken.length;
    const inter = p.blokken.filter((b) => st.blokken.interactief.includes(b.type)).map((b) => NAAM[b.type] || b.type);
    const regie = h.groep('Regie', `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <label class="tk-field" style="margin:0;min-width:140px"><span class="tk-field-l">Thema</span><select class="ib-input cm-mini" onchange="__cmWeThema(this.value)">${st.blokken.themas.map((t) => `<option ${t === p.thema ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <div style="font-size:12px;align-self:end;color:var(--text-2)">Hero: <b>${esc(p.blokken[0] && p.blokken[0].variant)}</b> · Interactief: <b>${esc(inter.join(', ') || '—')}</b></div></div>
      ${r.rode_draad ? `<div style="font-size:12.5px;margin-bottom:4px"><b>Rode draad.</b> ${esc(r.rode_draad)}</div>` : ''}
      ${r.nugget ? `<div style="font-size:12.5px;margin-bottom:4px"><b>Nugget.</b> ${esc(r.nugget)}</div>` : ''}
      ${r.open_lus ? `<div style="font-size:12.5px;margin-bottom:4px"><b>Open lus.</b> ${esc(r.open_lus)}</div>` : ''}
      ${r.motivatie ? `<div style="font-size:12px;color:var(--text-2);margin-top:6px;border-left:3px solid var(--border);padding-left:8px"><b>Waarom zo (regisseur).</b> ${esc(r.motivatie)}</div>` : ''}
      ${(r.blokken || []).some((x) => x && x.waarom) ? `<details style="margin-top:6px;font-size:12px"><summary>Keuze per blok</summary><ol style="margin:4px 0 0 18px">${r.blokken.map((x) => `<li><b>${esc(NAAM[x.type] || x.type)}</b> — ${esc(x.waarom || '')}</li>`).join('')}</ol></details>` : ''}`);
    const seo = h.groep('Delen & zoekmachines', h.veld('pagina.seo_titel', 'SEO-titel') + h.veld('pagina.seo_beschrijving', 'SEO-beschrijving', { lang: true }) + h.veld('pagina.og_titel', 'Deeltitel (OG)') + h.veld('pagina.og_beschrijving', 'Deelbeschrijving', { lang: true }));
    const toevoegen = `<div class="cm-wb-groep"><div class="cm-wb-groep-kop">Blok toevoegen</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <select class="ib-input cm-mini" style="width:auto" onchange="__cmWeToevoegType(this.value)"><option value="">Bloktype…</option>${st.blokken.blokken.filter((b) => b.type !== 'hero').map((b) => `<option value="${esc(b.type)}" ${st.toevoegType === b.type ? 'selected' : ''}>${esc(NAAM[b.type] || b.type)} · ${esc(b.categorie)}</option>`).join('')}</select>
        <select class="ib-input cm-mini" style="width:auto" onchange="__cmWeToevoegPlek(this.value)">${p.blokken.map((_, i) => i).filter((i) => i >= 1).map((i) => `<option value="${i}" ${(st.toevoegPlek != null ? st.toevoegPlek : n - 1) === i ? 'selected' : ''}>vóór blok ${i + 1}</option>`).join('')}<option value="${n}" ${st.toevoegPlek === n ? 'selected' : ''}>helemaal onderaan</option></select>
        <input class="ib-input cm-mini" style="flex:1;min-width:140px" placeholder="Waarover? (optioneel)" value="${esc(st.instructie.nieuw || '')}" oninput="__cmWeInstructie('nieuw',this.value)">
        <button class="btn btn-sm" onclick="__cmWeToevoegen()" ${st.bezig ? 'disabled' : ''}>${st.bezig === 'nieuw' ? 'Bezig…' : '+ Laat de machine het schrijven'}</button></div>
      <div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Regels: 1 hero bovenaan · min. 2 interactieve blokken · min. 1 nugget · precies 1 cadeau · ${(wb().drop.input || {}).vimeo_id ? 'precies 1 video-poort' : 'precies 1 inschrijven'} · 6 tot 14 blokken. Bewaren controleert dit.</div></div>`;
    return `${regie}<div class="cm-wb-groep"><div class="cm-wb-groep-kop">Blokken (${n})</div>${p.blokken.map((b, i) => blokKaart(b, i, n)).join('')}</div>${toevoegen}${seo}`;
  };

  // ── voorbeeld: de echte pagina ────────────────────────────────────────────
  window.__cmWeToestel = (t) => { st.toestel = t; H().teken('cm-wb-voorbeeld', window.__cmWeVoorbeeld()); };
  window.__cmWeVerversen = () => { st.stempel = Date.now(); H().teken('cm-wb-voorbeeld', window.__cmWeVoorbeeld()); };
  window.__cmWeMarkeer = () => { const el = document.getElementById('cm-we-melding'); if (el) el.style.display = 'block'; };
  window.__cmWeVoorbeeld = function () {
    const d = wb().drop;
    const tok = d.voorbeeld_token;
    if (!tok) return '<div class="card"><div class="card-body" style="font-size:12.5px;color:var(--text-2)">Geen voorbeeld-token: draai de migratie content_drops.voorbeeld_token.</div></div>';
    const url = `${PREVIEW}${tok}?v=${d.versie}-${st.stempel}`;
    const gsm = st.toestel === 'gsm';
    return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        <button class="btn btn-sm ${gsm ? 'btn-primary' : 'btn-ghost'}" onclick="__cmWeToestel('gsm')">📱 Gsm</button>
        <button class="btn btn-sm ${!gsm ? 'btn-primary' : 'btn-ghost'}" onclick="__cmWeToestel('desktop')">🖥 Desktop</button>
        <button class="btn btn-sm btn-ghost" onclick="__cmWeVerversen()">↻ Verversen</button>
        <a class="btn btn-sm btn-ghost" style="margin-left:auto" target="_blank" rel="noopener" href="${H().esc(url)}">Open in nieuw tabblad ↗</a></div>
      <div id="cm-we-melding" style="display:${wb().dirty ? 'block' : 'none'};font-size:12px;background:var(--amber-soft,#FFF4DB);border-radius:8px;padding:6px 10px;margin-bottom:6px">Het voorbeeld toont de <b>bewaarde</b> versie (v${d.versie}). Bewaar je wijzigingen om ze hier te zien.</div>
      <div class="cm-we-frame ${gsm ? 'gsm' : ''}"><iframe src="${H().esc(url)}" title="Voorbeeld van de Weekeditie" loading="lazy"></iframe></div>
      <div style="font-size:11px;color:var(--text-3);margin-top:4px">Echte pagina op de website, niet gepubliceerd (noindex, geen tracking, het formulier verstuurt niets).</div>`;
  };

  /** Platte tekst van de pagina (Kopieer teksten). */
  window.__cmWeTekst = function (o) {
    const p = o.pagina || {};
    const s = (x) => String(x || '').replace(/\*\*/g, '');
    const regels = ['PAGINA (Weekeditie · thema ' + (p.thema || '?') + ')'];
    (p.blokken || []).forEach((b, i) => {
      const q = b.props || {};
      const stukken = [q.eyebrow, q.titel, q.vraag, q.intro, q.voorkant, q.achterkant, q.tekst, q.uitleg,
        ...(q.stappen || []).map((x, j) => `${j + 1}. ${x.titel}: ${x.tekst}`),
        ...(q.opties || []).map((x, j) => `${String.fromCharCode(65 + j)}. ${x}`),
        ...(q.items || []).map((x) => `Mythe: ${x.mythe} — Feit: ${x.feit}`),
        ...(q.paren || []).map((x) => `${x.paar} (${x.bias}): ${x.zin}`),
        ...(q.cijfers || []).map((x) => `${x.prefix || ''}${x.waarde}${x.suffix || ''} ${x.label}`)].filter(Boolean).map(s);
      regels.push(`— ${String(i + 1).padStart(2, '0')} ${NAAM[b.type] || b.type}${b.variant ? ' (' + b.variant + ')' : ''}`, ...stukken);
    });
    return regels.join('\n');
  };

  // Stijl
  if (!document.getElementById('cm-we-css')) {
    const css = document.createElement('style'); css.id = 'cm-we-css';
    css.textContent = `.cm-we-blok{border:1px solid var(--border);border-radius:10px;margin-bottom:6px;background:var(--surface,#fff)}
      .cm-we-blok.open{border-color:var(--m,#6D3FD4)}
      .cm-we-kop{display:flex;gap:10px;align-items:center;padding:8px 10px;cursor:pointer}
      .cm-we-nr{font-family:var(--mono,monospace);font-size:12px;color:var(--text-3)}
      .cm-we-sam{font-size:12px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cm-we-act{display:flex;gap:8px;font-size:13px}
      .cm-we-body{padding:4px 12px 12px;border-top:1px dashed var(--border)}
      .cm-we-lijst{margin-bottom:8px}
      .cm-we-frame{border:1px solid var(--border);border-radius:12px;overflow:hidden;background:#0B1E2A;height:min(82vh,900px)}
      .cm-we-frame iframe{width:100%;height:100%;border:0;display:block}
      .cm-we-frame.gsm{width:400px;max-width:100%;margin:0 auto;border-radius:28px;border:8px solid #111;height:min(82vh,820px)}`;
    document.head.appendChild(css);
  }
})();
