// modules/klanten-v2/views/contentmachine-werkblad-v2.js
//
// Contentmachine — het drop-werkblad (na genereren). Wordt getoond door
// contentmachine-v2.js (tab Overzicht) zodra er een drop open staat.
//
//   Bovenaan:  Goedkeuren · Publiceer pagina · Kopieer teksten · Download alle beelden
//              (zip, fase 3) · Bewaar wijzigingen · versies.
//   Tabbladen: Pagina · Nieuwsbrief · Stories · Post · LinkedIn — per tab een
//              voorbeeld, elk tekstveld bewerkbaar, "Opnieuw genereren" voor enkel
//              dat onderdeel (met instructie) en per beeld "ander beeld kiezen".
//   Elke bewaring = nieuwe versie (server). Grens-overtredingen (verboden woorden,
//   namen zonder toestemming) staan in het rood en blokkeren Goedkeuren.
//
// API: /api/contentmachine/drops (bewaar-output, goedkeuren, publiceer, depubliceer,
// versie-terug), /api/contentmachine/genereer, /api/contentmachine/nieuwsbrief.
(function () {
  'use strict';
  window.DFO = window.DFO || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const toast = (m) => { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); };
  const api = (url, init) => window.KV.authedJson(url, init);
  const post = (url, b) => api(url, { method: 'POST', body: JSON.stringify(b) });
  const foutTekst = (e, val) => (e && e.body && e.body.error) || (e && e.message) || val;
  const pill = (c, t, titel) => `<span class="pill pill-${c} nodot"${titel ? ` title="${esc(titel)}"` : ''}>${esc(t)}</span>`;
  const kloon = (o) => JSON.parse(JSON.stringify(o == null ? null : o));
  const ZONE = 'Europe/Amsterdam';
  const fmtTijd = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('nl-NL', { timeZone: ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };

  const TABS = [['pagina', 'Pagina'], ['nieuwsbrief', 'Nieuwsbrief'], ['stories', 'Stories'], ['post', 'Post'], ['linkedin', 'LinkedIn']];
  const STATUS = { concept: ['neutral', 'Concept'], gegenereerd: ['accent', 'Gegenereerd'], goedgekeurd: ['warn', 'Goedgekeurd'], gepubliceerd: ['ok', 'Gepubliceerd'], gearchiveerd: ['neutral', 'Gearchiveerd'] };
  const FORMATS = {
    trade_ontleed: 'De trade ontleed', wat_zou_jij_doen: 'Wat zou jij doen?', achter_de_schermen: 'Achter de schermen',
    het_bewijs: 'Het bewijs', fout_van_de_week: 'De fout van de week', een_regel_diep: 'Eén regel, diep',
    vooruitblik: 'Vooruitblik', vraag_van_student: 'Vraag van een student',
  };
  const BLOK_LABEL = {
    opener: 'Opener', video: 'Video', chart: 'Chart', trade_ontleed: 'Trade ontleed', quiz: 'Quiz', payout: 'Payout',
    tip_van_de_week: 'Tip van de week', mythe: 'Mythe', vooruitblik: 'Vooruitblik', cijfers: 'Cijfers', cadeau: 'Cadeau', ps: 'PS',
  };
  const ROL_LABEL = { hook: 'Hook', inhoud: 'Inhoud', bewijs: 'Bewijs', cta: 'Call to action' };
  const TRAINING = 'https://training.deforexopleiding.nl';

  const wb = window.__cmWb = window.__cmWb || {
    open: false, drop: null, assets: [], versies: [], output: null, dirty: false, tab: 'pagina',
    bezig: null, instructie: {}, onderwerp: 0, nbHtml: null, nbVoor: null, kiezer: null, laden: false,
  };

  function rerender() { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); }
  function teken(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; else rerender(); }
  const assetMap = () => Object.fromEntries((wb.assets || []).map((a) => [a.id, a]));
  /** Social 2.0 (varianten, contentmachine-social2-v2.js) of de oude vorm? */
  const s2 = () => !!(window.__cmSocial2 && window.__cmSocial2.isV2(wb.output));

  // ── Laden / openen ────────────────────────────────────────────────────────
  async function laad(id) {
    wb.laden = true; rerender();
    try {
      const [d, bib] = await Promise.all([
        api('/api/contentmachine/drops?id=' + encodeURIComponent(id)),
        api('/api/contentmachine/assets?bibliotheek=1'),
      ]);
      zet(d.drop, [...(d.assets || []), ...((bib && bib.assets) || [])], d.versies || []);
    } catch (e) { toast(foutTekst(e, 'Drop laden mislukt.')); wb.open = false; }
    wb.laden = false; rerender();
  }
  function zet(drop, assets, versies) {
    wb.open = true; wb.drop = drop; wb.output = kloon(drop.output); wb.dirty = false;
    if (assets) wb.assets = assets;
    if (versies) wb.versies = versies;
    wb.nbHtml = null; wb.nbVoor = null;
    if (!wb.ghl || wb.ghl.dropId !== drop.id) wb.ghl = { dropId: drop.id, geladen: false, bezig: null, data: null, fout: null };
  }
  window.__cmWbOpen = (id) => { wb.tab = 'pagina'; return laad(id); };
  window.__cmWbSluit = () => {
    if (wb.dirty && !window.confirm('Er zijn niet-bewaarde wijzigingen. Toch sluiten?')) return;
    wb.open = false; wb.drop = null; wb.output = null; wb.dirty = false;
    if (window.__cmIntern) { window.__cmIntern.st.lijst.fetched = false; }
    rerender();
  };
  window.__cmWbTab = (t) => { wb.tab = t; rerender(); };

  /** Genereer alles vanuit het invoerformulier; daarna het werkblad. */
  window.__cmGenereerStart = async (id) => {
    if (wb.bezig) return;
    wb.bezig = 'alles'; wb.open = true; wb.drop = wb.drop && wb.drop.id === id ? wb.drop : { id, slug: '…', status: 'concept' }; wb.output = null;
    if (window.DFO.goTab) window.DFO.goTab('Overzicht'); else rerender();
    try {
      const r = await post('/api/contentmachine/genereer', { id });
      wb.bezig = null;
      await laad(r.drop.id);
      toast('Drop gegenereerd' + (r.waarschuwingen && r.waarschuwingen.length ? ` — ${r.waarschuwingen.length} aandachtspunt(en)` : '') + '.');
    } catch (e) {
      wb.bezig = null; wb.open = false;
      toast(foutTekst(e, 'Genereren mislukt.'));
      console.error('[contentmachine-werkblad] genereren mislukt:', e && e.status, e && (e.body || e.message));
      rerender();
    }
  };

  // ── Paden in de output ────────────────────────────────────────────────────
  function haal(pad) { return pad.split('.').reduce((o, k) => (o == null ? undefined : o[k]), wb.output); }
  function zetPad(pad, waarde) {
    const delen = pad.split('.');
    let o = wb.output;
    for (let i = 0; i < delen.length - 1; i++) {
      if (o[delen[i]] == null) o[delen[i]] = /^\d+$/.test(delen[i + 1]) ? [] : {};
      o = o[delen[i]];
    }
    o[delen[delen.length - 1]] = waarde;
  }
  let vbTimer = null;
  const isWe = () => !!(wb.output && wb.output.pagina && Array.isArray(wb.output.pagina.blokken) && wb.output.pagina.blokken.length);
  function markeer() {
    if (!wb.dirty) { wb.dirty = true; teken('cm-wb-acties', actiesHtml()); }
    if (wb.tab === 'nieuwsbrief') { planVoorbeeld(); return; }
    // Weekeditie: het voorbeeld is de echte pagina (bewaarde versie); enkel de melding bijwerken.
    if (wb.tab === 'pagina' && isWe()) { if (typeof window.__cmWeMarkeer === 'function') window.__cmWeMarkeer(); return; }
    clearTimeout(vbTimer);
    vbTimer = setTimeout(() => teken('cm-wb-voorbeeld', voorbeeldHtml()), 400);
  }
  window.__cmWbVeld = (pad, waarde) => { zetPad(pad, waarde); markeer(); };
  window.__cmWbLijst = (pad, waarde) => { zetPad(pad, String(waarde).split(/[,\n]/).map((x) => x.trim()).filter(Boolean)); markeer(); };

  // ── Acties ────────────────────────────────────────────────────────────────
  async function actie(naam, extra, bericht) {
    try {
      const r = await post('/api/contentmachine/drops', { actie: naam, id: wb.drop.id, ...(extra || {}) });
      const versies = await api('/api/contentmachine/drops?id=' + encodeURIComponent(wb.drop.id)).then((x) => x.versies).catch(() => wb.versies);
      zet(r.drop, null, versies);
      if (bericht) toast(bericht);
      rerender();
      return r;
    } catch (e) {
      toast(foutTekst(e, 'Mislukt.'));
      console.error('[contentmachine-werkblad] actie mislukt:', naam, e && e.status, e && (e.body || e.message));
      return null;
    }
  }
  window.__cmWbBewaar = () => actie('bewaar-output', { versie: wb.drop.versie, output: wb.output }, 'Wijzigingen bewaard (nieuwe versie).');
  window.__cmWbGoedkeuren = async () => {
    if (wb.dirty) { const r = await window.__cmWbBewaar(); if (!r) return; }
    return actie('goedkeuren', {}, 'Goedgekeurd.');
  };
  window.__cmWbPubliceer = () => {
    if (!window.confirm(`De pagina ${TRAINING.replace('https://', '')}/${wb.drop.slug} publiceren?`)) return null;
    return actie('publiceer', {}, 'Pagina gepubliceerd.');
  };
  window.__cmWbDepubliceer = () => {
    if (!window.confirm('De pagina offline halen? (De drop blijft goedgekeurd.)')) return null;
    return actie('depubliceer', {}, 'Pagina offline gehaald.');
  };
  window.__cmWbVersieTerug = (v) => {
    if (!v) return;
    if (!window.confirm(`Versie ${v} terugzetten? Dat wordt een nieuwe versie; niets gaat verloren.`)) return;
    actie('versie-terug', { versie: Number(v) }, `Versie ${v} teruggezet.`);
  };
  window.__cmWbBewerkInvoer = () => {
    if (wb.dirty && !window.confirm('Niet-bewaarde wijzigingen gaan verloren. Doorgaan?')) return;
    const d = wb.drop; wb.open = false;
    if (typeof window.__cmOpenInvoer === 'function') window.__cmOpenInvoer(d.id);
  };

  window.__cmWbInstructie = (onderdeel, v) => { wb.instructie[onderdeel] = v; };
  window.__cmWbHergenereer = async (onderdeel) => {
    if (wb.bezig) return;
    if (wb.dirty && !window.confirm('Niet-bewaarde wijzigingen in dit werkblad gaan verloren. Doorgaan?')) return;
    wb.bezig = onderdeel; teken('cm-wb-regen-' + onderdeel, regenHtml(onderdeel));
    try {
      const r = await post('/api/contentmachine/genereer', { id: wb.drop.id, onderdeel, instructie: wb.instructie[onderdeel] || '' });
      wb.bezig = null; wb.instructie[onderdeel] = '';
      const versies = await api('/api/contentmachine/drops?id=' + encodeURIComponent(wb.drop.id)).then((x) => x.versies).catch(() => wb.versies);
      zet(r.drop, null, versies);
      toast(`${onderdeel} opnieuw gegenereerd.`);
    } catch (e) {
      wb.bezig = null;
      toast(foutTekst(e, 'Opnieuw genereren mislukt.'));
    }
    rerender();
  };
  window.__cmWbAllesOpnieuw = async () => {
    if (!window.confirm('De volledige drop opnieuw genereren? (De huidige versie blijft in de historiek.)')) return;
    window.__cmGenereerStart(wb.drop.id);
  };

  // Kopieer alle teksten (platte tekst per kanaal).
  function alleTeksten() {
    const o = wb.output || {};
    const p = o.pagina || {}; const n = o.nieuwsbrief || {};
    const strip = (s) => String(s || '').replace(/\*\*/g, '');
    const delen = [];
    delen.push(`DROP ${wb.drop.slug} — ${FORMATS[o.format_key] || o.format_key || ''}\nKernidee: ${o.kernidee || ''}`);
    if (isWe() && typeof window.__cmWeTekst === 'function') delen.push(window.__cmWeTekst(o));
    else delen.push(['PAGINA', `${p.hero_kicker}`, `${p.hero_titel} ${p.hero_accent}`, strip(p.lead), ...(p.frustraties || []).map((x) => '- ' + x), strip(p.frustraties_antwoord), ...(p.kaarten || []).map((k) => `[${k.label}] ${k.titel}: ${k.tekst}`), strip(p.quote)].filter(Boolean).join('\n'));
    if (typeof n.opener === 'string' && n.nugget) delen.push(['NIEUWSBRIEF (teaser)', 'Onderwerpen:', ...(n.onderwerpen || []).map((x, i) => `${String.fromCharCode(65 + i)}. ${x}`), `Preheader: ${n.preheader || ''}`, '', strip(n.opener), '', `${(n.nugget || {}).titel || ''}\n${strip((n.nugget || {}).tekst)}`, '', `${(n.open_lus || {}).vraag || ''}\n${strip((n.open_lus || {}).tekst)}`, '', 'Knop: Lees de volledige weekeditie', n.ps ? `PS ${n.ps}` : ''].filter((x) => x !== undefined).join('\n'));
    else delen.push(['NIEUWSBRIEF', 'Onderwerpen:', ...(n.onderwerpen || []).map((x, i) => `${String.fromCharCode(65 + i)}. ${x}`), `Preheader: ${n.preheader || ''}`,
      ...(n.blokken || []).map((b) => [`— ${BLOK_LABEL[b.type] || b.type}`, b.titel, b.vraag, strip(b.tekst), ...(b.stappen || []).map((s, i) => `${i + 1}. ${s.titel}: ${s.tekst}`), ...(b.opties || []).map((x, i) => `${String.fromCharCode(65 + i)}. ${x}`), b.getal ? `${b.getal} ${b.getal_label || ''}` : ''].filter(Boolean).join('\n')),
      n.ps ? `PS ${n.ps}` : ''].filter(Boolean).join('\n'));
    if (s2()) {
      const c = window.__cmSocial2.captions(o, wb.drop.slug);
      const beeld = (b) => [b.eyebrow, strip(b.titel), b.tekst, b.getal ? `Getal: ${b.getal.prefix || ''}${b.getal.waarde}${b.getal.suffix || ''} ${b.getal.label || ''}` : ''].filter(Boolean).join('\n');
      delen.push(['STORIES', ...(o.stories || []).map((s, i) => `${i + 1}. [${s.rol} · ${s.variant}]\n${beeld(s)}`), `Linksticker (${c.instagram_story_sticker}): ${c.instagram_story_link}`].join('\n\n'));
      delen.push(['INSTAGRAM-CARROUSEL', ...((o.post || {}).slides || []).map((s, i) => `Slide ${i + 1} [${s.variant}]\n${beeld(s)}`), `Vierkant [${(o.vierkant || {}).variant}]\n${beeld(o.vierkant || {})}`, 'CAPTION:', c.instagram_post, `Link in bio: ${c.instagram_bio_link}`].join('\n\n'));
      delen.push(['LINKEDIN', c.linkedin].join('\n'));
      return delen.join('\n\n────────\n\n');
    }
    delen.push(['STORIES', ...(o.stories || []).map((s, i) => `${i + 1}. [${ROL_LABEL[s.rol] || s.rol}] ${s.kicker} — ${s.titel}\n${s.tekst}\nSticker (${s.sticker}): ${s.sticker_tekst}`)].join('\n\n'));
    const post = o.post || {};
    delen.push(['INSTAGRAM-POST', ...(post.slides || []).map((s, i) => `Slide ${i + 1}: ${s.titel}\n${s.tekst}`), '', 'Caption:', post.caption, (post.hashtags || []).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' '), '', `Vierkant: ${(o.vierkant || {}).titel} — ${(o.vierkant || {}).sub}`].join('\n'));
    delen.push(['LINKEDIN', (o.linkedin || {}).tekst].join('\n'));
    return delen.join('\n\n────────\n\n');
  }
  window.__cmWbAlleTeksten = () => (wb.drop && wb.output ? alleTeksten() : '');
  window.__cmWbKopieer = async () => {
    try { await navigator.clipboard.writeText(alleTeksten()); toast('Alle teksten gekopieerd.'); }
    catch (_) { toast('Kopiëren lukte niet (browser).'); }
  };
  window.__cmWbKopieerDeel = async (tekst) => {
    try { await navigator.clipboard.writeText(tekst); toast('Gekopieerd.'); } catch (_) { toast('Kopiëren lukte niet.'); }
  };

  // ── Beeldkiezer (modal-achtig paneel in het werkblad) ─────────────────────
  window.__cmWbKiesBeeld = (pad) => { wb.kiezer = pad; teken('cm-wb-kiezer', kiezerHtml()); const el = document.getElementById('cm-wb-kiezer'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  window.__cmWbKiezerSluit = () => { wb.kiezer = null; teken('cm-wb-kiezer', ''); };
  window.__cmWbKiesId = (id) => {
    const pad = wb.kiezer; wb.kiezer = null;
    zetPad(pad, id || null); wb.dirty = true; rerender();
  };
  function kiezerHtml() {
    if (!wb.kiezer) return '';
    const huidig = haal(wb.kiezer);
    const eigen = wb.assets.filter((a) => a.drop_id === wb.drop.id);
    const bib = wb.assets.filter((a) => !a.drop_id);
    const tegel = (a) => `<button type="button" class="cm-kies ${a.id === huidig ? 'cm-kies-aan' : ''}" onclick="__cmWbKiesId('${esc(a.id)}')" title="${esc(a.bijschrift || a.soort)}">
      <img src="${esc(a.publieke_url)}" alt="" loading="lazy"><span class="cm-kies-label">${esc(a.soort)}${a.persoon_naam ? ' · ' + esc(a.persoon_naam) + (a.toestemming_publiek ? '' : ' (geen toestemming)') : ''}</span></button>`;
    return `<div class="card" style="margin:10px 0;border:2px solid var(--m,#6D3FD4)"><div class="card-head" style="justify-content:space-between"><div class="card-title">Ander beeld kiezen · <span style="font-family:var(--mono,monospace);font-size:11px">${esc(wb.kiezer)}</span></div>
      <div style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" onclick="__cmWbKiesId('')">Geen beeld</button><button class="btn btn-sm" onclick="__cmWbKiezerSluit()">Sluiten</button></div></div>
      <div class="card-body">${eigen.length ? `<div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Van deze week</div><div class="cm-kies-grid" style="margin-bottom:10px">${eigen.map(tegel).join('')}</div>` : ''}
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Bibliotheek</div><div class="cm-kies-grid">${bib.map(tegel).join('') || '<span style="color:var(--text-3);font-size:12px">Leeg</span>'}</div></div></div>`;
  }

  // ── Veld-bouwstenen ───────────────────────────────────────────────────────
  function veld(pad, label, { lang = false, hint = '', rijen = 3 } = {}) {
    const v = haal(pad);
    const waarde = v == null ? '' : String(v);
    const invoer = lang || waarde.length > 90
      ? `<textarea class="ib-input cm-mini" rows="${rijen}" oninput="__cmWbVeld('${pad}',this.value)">${esc(waarde)}</textarea>`
      : `<input class="ib-input cm-mini" value="${esc(waarde)}" oninput="__cmWbVeld('${pad}',this.value)">`;
    return `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">${esc(label)}${hint ? ` <span style="color:var(--text-3);font-weight:400">· ${esc(hint)}</span>` : ''}</span>${invoer}</label>`;
  }
  function beeldVeld(pad, label = 'Beeld') {
    const id = haal(pad);
    const a = id ? assetMap()[id] : null;
    return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <div class="cm-wb-mini">${a ? `<img src="${esc(a.publieke_url)}" alt="">` : '<span>—</span>'}</div>
      <div style="font-size:12px"><div class="tk-field-l">${esc(label)}</div>${a ? esc(a.bijschrift || a.soort) + (a.persoon_naam && !a.toestemming_publiek ? ' ' + pill('warn', 'naam niet publiek') : '') : '<span style="color:var(--text-3)">geen beeld</span>'}
      <div><a href="javascript:void(0)" onclick="__cmWbKiesBeeld('${pad}')">ander beeld kiezen</a></div></div></div>`;
  }
  function regenHtml(onderdeel) {
    const bezig = wb.bezig === onderdeel;
    return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input class="ib-input cm-mini" style="flex:1;min-width:180px" placeholder="Instructie (optioneel): korter, meer spanning, andere hook…" value="${esc(wb.instructie[onderdeel] || '')}" oninput="__cmWbInstructie('${onderdeel}',this.value)" ${bezig ? 'disabled' : ''}>
      <button class="btn btn-sm" onclick="__cmWbHergenereer('${onderdeel}')" ${wb.bezig ? 'disabled' : ''}>${bezig ? 'Bezig… (±1 min)' : '↻ Opnieuw genereren'}</button></div>`;
  }
  const regenBalk = (onderdeel) => `<div class="card" style="margin-bottom:10px"><div class="card-body" id="cm-wb-regen-${onderdeel}" style="padding:10px 12px">${regenHtml(onderdeel)}</div></div>`;
  const groep = (titel, inhoud, extra = '') => `<div class="cm-wb-groep"><div class="cm-wb-groep-kop">${esc(titel)}${extra}</div>${inhoud}</div>`;
  const pijltjes = (lijstPad, i, n) => `<span style="float:right;font-size:11.5px;font-weight:400">
    ${i > 0 ? `<a href="javascript:void(0)" onclick="__cmWbVerschuif('${lijstPad}',${i},-1)" title="Omhoog">↑</a>` : ''}
    ${i < n - 1 ? `<a href="javascript:void(0)" onclick="__cmWbVerschuif('${lijstPad}',${i},1)" title="Omlaag">↓</a>` : ''}
    <a href="javascript:void(0)" style="color:var(--rose);margin-left:4px" onclick="__cmWbVerwijderItem('${lijstPad}',${i})" title="Verwijderen">✕</a></span>`;
  window.__cmWbVerschuif = (pad, i, d) => {
    const l = haal(pad); if (!Array.isArray(l)) return;
    const j = i + d; if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]]; wb.dirty = true; rerender();
  };
  window.__cmWbVerwijderItem = (pad, i) => {
    const l = haal(pad); if (!Array.isArray(l)) return;
    if (!window.confirm('Dit onderdeel verwijderen?')) return;
    l.splice(i, 1); wb.dirty = true; rerender();
  };

  // ── Editors per tab ───────────────────────────────────────────────────────
  function paginaEditor() {
    if (isWe()) return typeof window.__cmWeEditor === 'function' ? window.__cmWeEditor() : '<div style="color:var(--text-3);font-size:12px">Weekeditie-editor laden…</div>';
    const p = haal('pagina') || {};
    const update = wb.drop.soort !== 'training';
    return [
      groep('Hero', veld('pagina.hero_kicker', 'Kicker') + veld('pagina.hero_titel', 'Titel') + veld('pagina.hero_accent', 'Accent (goud)') + veld('pagina.lead', 'Intro', { lang: true, hint: '**vet** mag' })
        + (p.feiten || []).map((f, i) => veld(`pagina.feiten.${i}.tekst`, `Feit ${i + 1} (${f.icoon})`)).join('')),
      groep('Formulier (vast)', `<div style="font-size:12px;color:var(--text-2);line-height:1.5">Deze teksten zijn vast: de bezoeker vult naam, e-mail en gsm-nummer in, ${update ? 'en staat meteen op de lijst voor de wekelijkse analyse' : 'en de video start meteen op de pagina'}. Er wordt nooit een link gemaild.</div>
        <div style="font-size:12px;margin-top:6px"><b>${esc(p.formulier_titel || '')}</b> · ${esc(p.formulier_sub || '')} · knop „${esc(p.knop || '')}”</div>`),
      groep('Herkenning', veld('pagina.frustraties_titel', 'Titel') + (p.frustraties || []).map((_, i) => veld(`pagina.frustraties.${i}`, `Punt ${i + 1}`)).join('') + veld('pagina.frustraties_antwoord', 'Antwoord', { lang: true })),
      groep('Inhoud', veld('pagina.inhoud_titel', 'Titel') + (p.kaarten || []).map((k, i) => `<div class="cm-wb-sub"><b style="font-size:12px">Kaart ${i + 1}</b>${pijltjes('pagina.kaarten', i, p.kaarten.length)}${veld(`pagina.kaarten.${i}.label`, 'Label')}${veld(`pagina.kaarten.${i}.titel`, 'Titel')}${veld(`pagina.kaarten.${i}.tekst`, 'Tekst', { lang: true })}${beeldVeld(`pagina.kaarten.${i}.beeld_asset_id`)}</div>`).join('')
        + `<label class="tk-field"><span class="tk-field-l">Paren (komma-gescheiden)</span><input class="ib-input cm-mini" value="${esc((p.paren || []).join(', '))}" oninput="__cmWbLijst('pagina.paren',this.value)"></label>`),
      update || p.verhaal || (p.galerij || []).length || (p.trade_stappen || []).length ? groep('Update-pagina (zonder video)',
        veld('pagina.verhaal', 'Verhaal van de week', { lang: true, rijen: 6 })
        + (p.galerij || []).map((g, i) => `<div class="cm-wb-sub"><b style="font-size:12px">Galerij ${i + 1}</b>${pijltjes('pagina.galerij', i, p.galerij.length)}${beeldVeld(`pagina.galerij.${i}.asset_id`)}${veld(`pagina.galerij.${i}.bijschrift`, 'Bijschrift')}</div>`).join('')
        + (p.trade_stappen || []).map((s, i) => `<div class="cm-wb-sub"><b style="font-size:12px">Trade-stap ${i + 1}</b>${pijltjes('pagina.trade_stappen', i, p.trade_stappen.length)}${veld(`pagina.trade_stappen.${i}.titel`, 'Titel')}${veld(`pagina.trade_stappen.${i}.tekst`, 'Tekst', { lang: true })}</div>`).join('')) : '',
      p.quiz ? groep('Quiz-antwoord (op de pagina)', veld('pagina.quiz.vraag', 'Vraag') + (p.quiz.opties || []).map((_, i) => veld(`pagina.quiz.opties.${i}`, `Optie ${String.fromCharCode(65 + i)}`)).join('')
        + `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">Juiste antwoord</span><select class="ib-input cm-mini" onchange="__cmWbVeld('pagina.quiz.antwoord_index',Number(this.value))">${(p.quiz.opties || []).map((_, i) => `<option value="${i}" ${p.quiz.antwoord_index === i ? 'selected' : ''}>${String.fromCharCode(65 + i)}</option>`).join('')}</select></label>`
        + veld('pagina.quiz.uitleg', 'Uitleg', { lang: true })) : '',
      groep('Citaat', veld('pagina.quote', 'Citaat', { lang: true, hint: '**…** wordt goud' })),
      groep('Delen & zoekmachines', veld('pagina.og_titel', 'Deeltitel (OG)') + veld('pagina.og_beschrijving', 'Deelbeschrijving', { lang: true }) + veld('pagina.seo_titel', 'Paginatitel') + veld('pagina.seo_beschrijving', 'Metabeschrijving', { lang: true })),
    ].join('');
  }

  function blokVelden(b, i, n) {
    const pad = `nieuwsbrief.blokken.${i}`;
    const heeft = (k) => b[k] != null && b[k] !== '' || ({
      opener: ['titel', 'tekst'], video: ['titel', 'tekst', 'knop_tekst'], chart: ['titel', 'tekst', 'beeld_asset_id'], trade_ontleed: ['titel', 'tekst', 'stappen'],
      quiz: ['vraag', 'opties'], payout: ['titel', 'tekst', 'beeld_asset_id'], tip_van_de_week: ['titel', 'tekst'], mythe: ['titel', 'tekst'],
      vooruitblik: ['titel', 'tekst'], cijfers: ['getal', 'getal_label', 'tekst'], cadeau: ['titel', 'tekst', 'knop_tekst'], ps: ['tekst'],
    }[b.type] || []).includes(k);
    let h = '';
    if (heeft('kicker')) h += veld(`${pad}.kicker`, 'Kicker');
    if (heeft('titel')) h += veld(`${pad}.titel`, b.type === 'mythe' ? 'Mythe (doorstreept)' : 'Titel');
    if (heeft('vraag')) h += veld(`${pad}.vraag`, 'Vraag');
    if (heeft('getal')) h += veld(`${pad}.getal`, 'Getal') + veld(`${pad}.getal_label`, 'Bij het getal');
    if (heeft('tekst')) h += veld(`${pad}.tekst`, 'Tekst', { lang: true, hint: '**vet** mag' });
    if (heeft('opties')) h += (b.opties || []).map((_, j) => veld(`${pad}.opties.${j}`, `Optie ${String.fromCharCode(65 + j)}`)).join('');
    if (heeft('stappen')) h += (b.stappen || []).map((_, j) => `<div style="display:grid;grid-template-columns:1fr 2fr;gap:6px">${veld(`${pad}.stappen.${j}.titel`, `Stap ${j + 1}`)}${veld(`${pad}.stappen.${j}.tekst`, 'Uitleg')}</div>`).join('');
    if (heeft('knop_tekst')) h += veld(`${pad}.knop_tekst`, 'Knop');
    if (['chart', 'payout', 'trade_ontleed', 'quiz', 'vooruitblik'].includes(b.type) || b.beeld_asset_id) h += beeldVeld(`${pad}.beeld_asset_id`);
    return `<div class="cm-wb-sub"><b style="font-size:12px">${i + 1}. ${esc(BLOK_LABEL[b.type] || b.type)}</b>${pijltjes('nieuwsbrief.blokken', i, n)}${h}</div>`;
  }

  function nieuwsbriefEditor() {
    const n = haal('nieuwsbrief') || {};
    if (typeof n.opener === 'string' && n.nugget && typeof window.__cmWeNbEditor === 'function') return window.__cmWeNbEditor();
    const bl = n.blokken || [];
    return [
      groep('Onderwerp (A/B-varianten)', (n.onderwerpen || []).map((_, i) => veld(`nieuwsbrief.onderwerpen.${i}`, `Variant ${String.fromCharCode(65 + i)}`)).join('') + veld('nieuwsbrief.preheader', 'Preheader')),
      groep('Blokken', bl.map((b, i) => blokVelden(b, i, bl.length)).join('')),
      groep('PS', veld('nieuwsbrief.ps', 'PS', { lang: true })),
    ].join('');
  }

  function storiesEditor() {
    const s = haal('stories') || [];
    return s.map((x, i) => groep(`Story ${i + 1} · ${ROL_LABEL[x.rol] || x.rol}`,
      veld(`stories.${i}.kicker`, 'Kicker') + veld(`stories.${i}.titel`, 'Titel') + veld(`stories.${i}.tekst`, 'Tekst', { lang: true })
      + beeldVeld(`stories.${i}.beeld_asset_id`)
      + `<div style="display:grid;grid-template-columns:120px 1fr;gap:6px"><label class="tk-field"><span class="tk-field-l">Sticker</span><select class="ib-input cm-mini" onchange="__cmWbVeld('stories.${i}.sticker',this.value)">${['link', 'poll', 'vraag', 'quiz'].map((t) => `<option ${x.sticker === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>${veld(`stories.${i}.sticker_tekst`, 'Stickertekst')}</div>`,
      pijltjes('stories', i, s.length))).join('')
      + `<div style="font-size:11.5px;color:var(--text-3)">Linksticker: ${esc(TRAINING.replace('https://', ''))}/${esc(wb.drop.slug)}?src=ig-story&amp;utm_source=instagram&amp;utm_medium=story&amp;utm_campaign=drop-${esc(wb.drop.slug)}
        <a href="javascript:void(0)" onclick="__cmWbKopieerDeel('${esc(storyLink())}')">kopieer</a></div>`;
  }
  function storyLink() { return `${TRAINING}/${wb.drop.slug}?src=ig-story&utm_source=instagram&utm_medium=story&utm_campaign=drop-${wb.drop.slug}`; }

  function postEditor() {
    const p = haal('post') || {};
    return (p.slides || []).map((x, i) => groep(`Slide ${i + 1}`, veld(`post.slides.${i}.titel`, 'Titel') + veld(`post.slides.${i}.tekst`, 'Tekst', { lang: true }) + beeldVeld(`post.slides.${i}.beeld_asset_id`), pijltjes('post.slides', i, p.slides.length))).join('')
      + groep('Caption', veld('post.caption', 'Caption', { lang: true, rijen: 8 }) + `<label class="tk-field"><span class="tk-field-l">Hashtags (komma-gescheiden)</span><input class="ib-input cm-mini" value="${esc((p.hashtags || []).join(', '))}" oninput="__cmWbLijst('post.hashtags',this.value)"></label>`)
      + groep('Vierkant 1080×1080', veld('vierkant.titel', 'Titel') + veld('vierkant.sub', 'Ondertitel') + beeldVeld('vierkant.beeld_asset_id'));
  }

  function linkedinEditor() {
    const l = haal('linkedin') || {};
    return groep('LinkedIn-post', veld('linkedin.tekst', 'Tekst', { lang: true, rijen: 14 })
      + `<label class="tk-field"><span class="tk-field-l">Beeld</span><select class="ib-input cm-mini" onchange="__cmWbVeld('linkedin.beeld',this.value)"><option value="vierkant" ${l.beeld === 'vierkant' ? 'selected' : ''}>Vierkant</option><option value="slide1" ${l.beeld === 'slide1' ? 'selected' : ''}>Slide 1 van de carrousel</option></select></label>`);
  }

  // ── Voorbeelden ───────────────────────────────────────────────────────────
  const vet = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  const goud = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<em>$1</em>');
  const img = (id, cls = '') => { const a = id ? assetMap()[id] : null; return a ? `<img class="${cls}" src="${esc(a.publieke_url)}" alt="">` : ''; };

  /** Benadering van de websitepagina (de echte pagina komt in fase 4 uit deze teksten). */
  function paginaHtml() {
    const o = wb.output || {}; const p = o.pagina || {}; const i = wb.drop.input || {};
    const update = wb.drop.soort !== 'training';
    const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,Arial,sans-serif;background:linear-gradient(180deg,#112B3B,#0B1E2A 60%);color:#fff;padding:22px;line-height:1.5}
      .k{color:#D0A050;font-weight:800;font-size:11px;letter-spacing:.16em;text-transform:uppercase}h1{font-size:40px;line-height:1;letter-spacing:-.03em;font-weight:900;margin:12px 0}h1 em{font-style:normal;color:#E2B866}
      .lead{color:#D9E3E8;font-size:15px}.lead b{color:#fff}.facts{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.facts span{font-size:12px;padding:6px 10px;border-radius:10px;border:1px solid rgba(217,227,232,.12);background:rgba(255,255,255,.04)}
      .gate{border-radius:18px;border:1px solid rgba(208,160,80,.5);background:#17364A;overflow:hidden;margin:16px 0}.scr{aspect-ratio:16/9;background:#0A1822 center/cover;display:grid;place-items:center;color:#8FA7B5;font-size:13px}
      .f{padding:14px}.f h3{font-size:17px}.f p{color:#8FA7B5;font-size:13px}.btn{display:block;text-align:center;background:#D0A050;color:#0B1E2A;font-weight:900;border-radius:12px;padding:12px;margin-top:10px}
      h2{font-size:24px;letter-spacing:-.02em;margin:26px 0 12px;font-weight:900}.pain{display:grid;gap:8px}.pain div{padding:12px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(217,227,232,.1);color:#D9E3E8;font-size:14px}
      .ans{margin-top:8px;padding:12px;border-left:3px solid #D0A050;background:rgba(208,160,80,.12);font-weight:600;font-size:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .card{border-radius:14px;padding:14px;background:rgba(31,69,95,.5);border:1px solid rgba(217,227,232,.1)}.card h4{font-size:16px;margin:6px 0}.card p{color:#D9E3E8;font-size:13px}.card img,.gal img{width:100%;border-radius:10px;margin-top:8px}
      .pairs span{display:inline-block;font-size:11px;font-weight:700;padding:4px 8px;border-radius:7px;border:1px solid rgba(217,227,232,.12);margin:3px 3px 0 0}.gal{display:grid;grid-template-columns:1fr 1fr;gap:10px}.gal div{font-size:12px;color:#8FA7B5}
      .q{margin-top:28px;padding:26px 18px;border-radius:20px;text-align:center;background:#17364A}.q p{font-size:22px;font-weight:800}.q em{font-style:normal;color:#D0A050}.disc{color:#8FA7B5;font-size:11px;text-align:center;margin-top:24px}
      .stap{display:flex;gap:10px;padding:8px 0;border-top:1px solid rgba(217,227,232,.1)}.stap b{color:#D0A050;font-weight:900}.verhaal p{color:#D9E3E8;margin-bottom:10px}`;
    const scr = i.vimeo_thumbnail ? `style="background-image:linear-gradient(rgba(11,30,42,.4),rgba(11,30,42,.8)),url('${esc(i.vimeo_thumbnail)}')"` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
      <div class="k">${esc(p.hero_kicker)}</div><h1>${esc(p.hero_titel)}<br><em>${esc(p.hero_accent)}</em></h1><p class="lead">${vet(p.lead)}</p>
      <div class="facts">${(p.feiten || []).map((f) => `<span>${esc(f.tekst)}</span>`).join('')}</div>
      <div class="gate">${update ? '' : `<div class="scr" ${scr}>🔒 ${esc(i.vimeo_titel || 'Opname')}</div>`}<div class="f"><h3>${esc(p.formulier_titel)}</h3><p>${esc(p.formulier_sub)}</p><span class="btn">${esc(p.knop)} →</span><p style="margin-top:8px">${vet(p.ontgrendeld_tekst)}</p></div></div>
      ${update && p.verhaal ? `<div class="verhaal"><h2>Deze week</h2><p>${vet(p.verhaal)}</p></div>` : ''}
      ${(p.galerij || []).length ? `<div class="gal">${p.galerij.map((g) => `<div>${img(g.asset_id)}${esc(g.bijschrift)}</div>`).join('')}</div>` : ''}
      ${(p.trade_stappen || []).length ? `<h2>De trade ontleed</h2>${p.trade_stappen.map((s, n) => `<div class="stap"><b>${String(n + 1).padStart(2, '0')}</b><div><b style="color:#fff">${esc(s.titel)}</b> <span style="color:#D9E3E8">${esc(s.tekst)}</span></div></div>`).join('')}` : ''}
      <h2>${esc(p.frustraties_titel)}</h2><div class="pain">${(p.frustraties || []).map((x) => `<div>${esc(x)}</div>`).join('')}</div><div class="ans">${vet(p.frustraties_antwoord)}</div>
      <h2>${esc(p.inhoud_titel)}</h2><div class="grid">${(p.kaarten || []).map((k) => `<div class="card"><div class="k">${esc(k.label)}</div><h4>${esc(k.titel)}</h4><p>${esc(k.tekst)}</p>${img(k.beeld_asset_id)}</div>`).join('')}</div>
      <div class="pairs" style="margin-top:10px">${(p.paren || []).map((x) => `<span>${esc(x)}</span>`).join('')}</div>
      ${p.quiz ? `<h2 id="quiz">${esc(p.quiz.vraag)}</h2>${(p.quiz.opties || []).map((x, n) => `<div class="card" style="margin-bottom:6px;${n === p.quiz.antwoord_index ? 'border-color:#3FC79A' : ''}">${String.fromCharCode(65 + n)}. ${esc(x)}${n === p.quiz.antwoord_index ? ' ✓' : ''}</div>`).join('')}<p class="lead" style="margin-top:8px">${vet(p.quiz.uitleg)}</p>` : ''}
      <div class="q"><p>${goud(p.quote)}</p><span class="btn" style="display:inline-block;margin-top:14px;padding:12px 20px">${esc(p.knop)} →</span></div>
      <div class="card" style="margin-top:20px;border-color:#D0A050"><div class="k">Cadeau</div><h4>Gratis strategiesessie met Dave</h4><p>t.w.v. €100, nu €0</p></div>
      <p class="disc">Educatief materiaal, geen financieel advies. Traden houdt risico's in: je kan je inleg verliezen.</p></body></html>`;
  }

  // Nieuwsbrief: server-render (zelfde renderer als bij het versturen).
  let nbTimer = null;
  function planVoorbeeld() { clearTimeout(nbTimer); nbTimer = setTimeout(laadNbVoorbeeld, 700); }
  async function laadNbVoorbeeld() {
    if (!wb.drop || !wb.output) return;
    try {
      const r = await post('/api/contentmachine/nieuwsbrief', { actie: 'voorbeeld', id: wb.drop.id, output: wb.output, onderwerp: wb.onderwerp });
      wb.nbHtml = r.html; wb.nbVoor = r.onderwerp;
    } catch (e) { wb.nbHtml = `<p style="font-family:sans-serif;color:#c00">${esc(foutTekst(e, 'Voorbeeld mislukt'))}</p>`; }
    teken('cm-wb-voorbeeld', voorbeeldHtml());
  }
  window.__cmWbOnderwerp = (i) => { wb.onderwerp = i; laadNbVoorbeeld(); };

  function iframe(html, hoogte) {
    return `<iframe class="cm-wb-frame" style="height:${hoogte}px" sandbox="allow-same-origin" srcdoc="${esc(html)}"></iframe>`;
  }

  function storyKaart(s) {
    return `<div class="cm-sv cm-sv-story">${img(s.beeld_asset_id, 'cm-sv-img')}<div class="cm-sv-k">${esc(s.kicker)}</div><div class="cm-sv-t">${esc(s.titel)}</div><div class="cm-sv-x">${esc(s.tekst)}</div>
      <div class="cm-sv-sticker">${s.sticker === 'link' ? '🔗 ' : s.sticker === 'poll' ? '📊 ' : s.sticker === 'quiz' ? '❓ ' : '💬 '}${esc(s.sticker_tekst)}</div></div>`;
  }

  function voorbeeldHtml() {
    const o = wb.output || {};
    const social = typeof window.__cmSocialPaneel === 'function';
    if (wb.tab === 'pagina' && isWe()) return `${social ? window.__cmSocialPaneel('pagina') : ''}${typeof window.__cmWeVoorbeeld === 'function' ? window.__cmWeVoorbeeld() : ''}`;
    if (wb.tab === 'pagina') return `${social ? window.__cmSocialPaneel('pagina') : ''}${iframe(paginaHtml(), 900)}`;
    if (wb.tab === 'nieuwsbrief') {
      const beeldPaneel = typeof window.__cmWeBeeldPaneel === 'function' ? window.__cmWeBeeldPaneel() : '';
      if (!wb.nbHtml) { planVoorbeeld(); return `<div id="cm-wb-ghl">${ghlPaneel()}</div>${beeldPaneel}<div style="color:var(--text-3);font-size:12px;padding:10px">Voorbeeld laden…</div>`; }
      const n = o.nieuwsbrief || {};
      return `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">${(n.onderwerpen || []).map((x, i) => `<button class="btn btn-sm ${wb.onderwerp === i ? 'btn-primary' : 'btn-ghost'}" style="font-size:11.5px" onclick="__cmWbOnderwerp(${i})" title="${esc(x)}">Variant ${String.fromCharCode(65 + i)}</button>`).join('')}
        <a class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:11.5px" href="javascript:void(0)" onclick="__cmWbDownloadNb()">⬇ HTML</a></div>
        <div style="font-size:12px;margin-bottom:6px"><b>${esc(wb.nbVoor || '')}</b><div style="color:var(--text-3)">${esc(n.preheader || '')}</div></div>${iframe(wb.nbHtml, 1100)}`
        .replace(/^/, `<div id="cm-wb-ghl">${ghlPaneel()}</div>${beeldPaneel}`);
    }
    if (['stories', 'post', 'linkedin'].includes(wb.tab) && s2()) return window.__cmSocial2.voorbeeld(wb.tab, wb.drop.slug);
    if (wb.tab === 'stories' && social) return window.__cmSocialPaneel('stories') + `<div style="font-size:11px;color:var(--text-3);margin-top:6px">Laat onderaan ruimte voor de Instagram-sticker (${(o.stories || []).map((x, i) => `${i + 1}: ${esc(x.sticker)}`).join(' · ')}).</div>`;
    if (wb.tab === 'stories') return `<div class="cm-sv-rij">${(o.stories || []).map(storyKaart).join('')}</div><div style="font-size:11px;color:var(--text-3);margin-top:6px">Ruwe voorvertoning — de definitieve 1080×1920-beelden komen uit de social-rendering.</div>`;
    if (wb.tab === 'post') {
      const p = o.post || {}; const v = o.vierkant || {};
      if (social) {
        const tags = (p.hashtags || []).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' ');
        return `${window.__cmSocialPaneel('post')}<div style="font-size:12.5px;white-space:pre-wrap;background:var(--surface-2);border-radius:10px;padding:10px;margin-top:10px">${esc(p.caption)}\n\n<span style="color:var(--brand,#0A7490)">${esc(tags)}</span>
          <div><a href="javascript:void(0)" onclick="__cmWbKopieerDeel(${esc(JSON.stringify(p.caption + '\n\n' + tags))})">kopieer caption</a></div></div>`;
      }
      return `<div class="cm-sv-rij">${(p.slides || []).map((s, i) => `<div class="cm-sv cm-sv-post">${img(s.beeld_asset_id, 'cm-sv-img')}<div class="cm-sv-k">${i + 1}/${p.slides.length}</div><div class="cm-sv-t">${esc(s.titel)}</div><div class="cm-sv-x">${esc(s.tekst)}</div></div>`).join('')}</div>
        <div style="display:flex;gap:12px;margin-top:12px;flex-wrap:wrap"><div class="cm-sv cm-sv-vierkant">${img(v.beeld_asset_id, 'cm-sv-img')}<div class="cm-sv-t">${esc(v.titel)}</div><div class="cm-sv-x">${esc(v.sub)}</div></div>
        <div style="flex:1;min-width:220px;font-size:12.5px;white-space:pre-wrap;background:var(--surface-2);border-radius:10px;padding:10px">${esc(p.caption)}\n\n<span style="color:var(--brand,#0A7490)">${esc((p.hashtags || []).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' '))}</span>
        <div><a href="javascript:void(0)" onclick="__cmWbKopieerDeel(${esc(JSON.stringify(p.caption + '\n\n' + (p.hashtags || []).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' ')))})">kopieer caption</a></div></div></div>`;
    }
    const l = o.linkedin || {};
    if (social) {
      return `<div style="max-width:520px;background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px">
        <div style="font-weight:700;font-size:13px">De Forex Opleiding</div><div style="font-size:13px;white-space:pre-wrap;margin-top:8px">${esc(l.tekst)}</div>
        <div><a href="javascript:void(0)" onclick="__cmWbKopieerDeel(${esc(JSON.stringify(l.tekst || ''))})">kopieer tekst</a></div></div>${window.__cmSocialPaneel('linkedin')}`;
    }
    return `<div style="max-width:520px;background:var(--surface,#fff);border:1px solid var(--border);border-radius:10px;padding:14px">
      <div style="font-weight:700;font-size:13px">De Forex Opleiding</div><div style="font-size:13px;white-space:pre-wrap;margin-top:8px">${esc(l.tekst)}</div>
      <div style="margin-top:10px">${l.beeld === 'slide1' ? `<div class="cm-sv cm-sv-post" style="width:100%">${img(((o.post || {}).slides || [])[0] && o.post.slides[0].beeld_asset_id, 'cm-sv-img')}<div class="cm-sv-t">${esc((((o.post || {}).slides || [])[0] || {}).titel)}</div></div>`
        : `<div class="cm-sv cm-sv-vierkant" style="width:100%">${img((o.vierkant || {}).beeld_asset_id, 'cm-sv-img')}<div class="cm-sv-t">${esc((o.vierkant || {}).titel)}</div><div class="cm-sv-x">${esc((o.vierkant || {}).sub)}</div></div>`}</div>
      <div><a href="javascript:void(0)" onclick="__cmWbKopieerDeel(${esc(JSON.stringify(l.tekst || ''))})">kopieer tekst</a></div></div>`;
  }

  // ── Nieuwsbrief via GoHighLevel (fase 5) ──────────────────────────────────
  // Template in GHL zetten, testmail naar jezelf, "Open in GHL", stats verversen.
  // De campagne naar de lijst maak en verstuur je ZELF in GHL — nooit vanuit het CRM.
  async function laadGhl() {
    const g = wb.ghl; if (!g || g.geladen || g.bezig === 'laden') return;
    g.bezig = 'laden';
    try { g.data = await api('/api/contentmachine/nieuwsbrief?ghl=1&id=' + encodeURIComponent(wb.drop.id)); g.fout = null; }
    catch (e) { g.fout = foutTekst(e, 'GHL-status laden mislukt.'); }
    g.bezig = null; g.geladen = true; teken('cm-wb-ghl', ghlPaneel());
  }
  window.__cmWbGhl = async (actie) => {
    const g = wb.ghl; if (!g || g.bezig) return;
    if (wb.dirty) { toast('Bewaar eerst je wijzigingen: GHL krijgt de bewaarde versie.'); return; }
    if (actie === 'naar-ghl' && !window.confirm('De nieuwsbrief als e-mailtemplate in GHL zetten (of het bestaande template van deze drop bijwerken)? Er wordt niets verstuurd.')) return;
    g.bezig = actie; teken('cm-wb-ghl', ghlPaneel());
    try {
      const r = await post('/api/contentmachine/nieuwsbrief', { actie, id: wb.drop.id, onderwerp: wb.onderwerp });
      g.data = { ...(g.data || {}), verzending: r.verzending || (g.data && g.data.verzending) || null, ...(r.ghl ? { ghl: r.ghl } : {}) };
      toast(actie === 'naar-ghl' ? 'Template staat in GHL.' : actie === 'test' ? `Testmail verstuurd naar ${r.naar}.` : `Stats ververst (${(r.campagnes || []).length} campagne(s) gevonden).`);
    } catch (e) { toast(foutTekst(e, 'GHL-actie mislukt.')); g.fout = foutTekst(e, ''); }
    g.bezig = null; teken('cm-wb-ghl', ghlPaneel());
  };
  function ghlPaneel() {
    const g = wb.ghl;
    if (!g) return '';
    if (!g.geladen) { queueMicrotask(laadGhl); return '<div class="cm-wb-groep" style="font-size:12px;color:var(--text-3)">GHL-status laden…</div>'; }
    const info = (g.data && g.data.ghl) || {};
    const v = g.data && g.data.verzending;
    if (!info.gekoppeld) {
      return `<div class="cm-wb-groep" style="font-size:12px"><b>Nieuwsbrief via GoHighLevel</b><div style="color:var(--amber);margin-top:4px">GHL nog niet gekoppeld — ontbrekende env: ${esc((info.ontbreekt || []).join(', ') || '?')}. De HTML kan je downloaden (⬇ HTML).</div></div>`;
    }
    const goed = ['goedgekeurd', 'gepubliceerd'].includes(wb.drop.status);
    const fmt = (iso) => (iso ? fmtTijd(iso) : '—');
    const st = v && v.stats && v.stats.laatste;
    const statsTekst = st ? [st.verstuurd != null ? `${st.verstuurd} verstuurd` : '', st.geopend != null ? `${st.geopend} geopend` : '', st.geklikt != null ? `${st.geklikt} geklikt` : '', st.uitgeschreven != null ? `${st.uitgeschreven} uitgeschreven` : ''].filter(Boolean).join(' · ')
      : (v && v.stats && v.stats.opgehaald_op ? 'GHL gaf (nog) geen cijfers voor deze campagne.' : '');
    const knop = (a, label, extra = '') => `<button class="btn btn-sm ${extra}" onclick="__cmWbGhl('${a}')" ${g.bezig ? 'disabled' : ''}>${g.bezig === a ? 'Bezig…' : label}</button>`;
    return `<div class="cm-wb-groep" style="font-size:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><b>Nieuwsbrief via GoHighLevel</b>
        ${v ? pill(v.status === 'verstuurd' ? 'ok' : v.status === 'ingepland' ? 'warn' : 'accent', { concept: 'Template in GHL', test_verstuurd: 'Test verstuurd', ingepland: 'Ingepland', verstuurd: 'Verstuurd' }[v.status] || v.status) : pill('neutral', 'Nog niet in GHL')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        ${goed ? knop('naar-ghl', v ? 'Template bijwerken in GHL' : 'Zet in GHL', 'btn-primary') : '<button class="btn btn-sm" disabled title="Keur de drop eerst goed">Zet in GHL (eerst goedkeuren)</button>'}
        ${knop('test', 'Stuur test naar mij')}
        ${info.links ? `<a class="btn btn-ghost btn-sm" href="${esc(info.links.campagnes)}" target="_blank" rel="noopener">Open in GHL ↗</a>` : ''}
        ${v ? knop('stats', 'Ververs stats', 'btn-ghost') : ''}
      </div>
      ${v ? `<div style="color:var(--text-3);margin-top:6px">Template: <span style="font-family:var(--mono,monospace)">${esc(v.template_id || '—')}</span> · onderwerp: ${esc(v.onderwerp || '—')} · test: ${esc(fmt(v.test_verstuurd_op))}${statsTekst ? `<div style="color:var(--text-2);margin-top:2px">${esc(statsTekst)}</div>` : ''}</div>` : ''}
      <ol style="margin:8px 0 0 18px;color:var(--text-2);line-height:1.5">
        <li>Kies hierboven de onderwerp-variant en klik <b>${v ? 'Template bijwerken in GHL' : 'Zet in GHL'}</b>.</li>
        <li><b>Stuur test naar mij</b> en kijk de mail na (links, beelden, uitschrijflink).</li>
        <li><b>Open in GHL</b> → nieuwe campagne → template <i>DFO drop ${esc(wb.drop.slug)} …</i> → ontvangers: de nieuwsbrief-tag/-lijst → onderwerp en preheader overnemen → <b>zelf</b> Verstuur of Plan in.</li>
      </ol></div>`;
  }

  window.__cmWbDownloadNb = async () => {
    try {
      const r = await post('/api/contentmachine/nieuwsbrief', { actie: 'voorbeeld', id: wb.drop.id, output: wb.output, onderwerp: wb.onderwerp });
      const blob = new Blob([r.html], { type: 'text/html' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nieuwsbrief-${wb.drop.slug}.html`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(foutTekst(e, 'Download mislukt.')); }
  };

  // ── Opbouw ────────────────────────────────────────────────────────────────
  function actiesHtml() {
    const d = wb.drop; const s = d.status;
    const knoppen = [];
    if (wb.dirty) knoppen.push('<button class="btn btn-primary btn-sm" onclick="__cmWbBewaar()">Bewaar wijzigingen</button>');
    if (s === 'gegenereerd') knoppen.push(`<button class="btn ${wb.dirty ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="__cmWbGoedkeuren()">✓ Goedkeuren</button>`);
    if (s === 'goedgekeurd') knoppen.push('<button class="btn btn-primary btn-sm" onclick="__cmWbPubliceer()">Publiceer pagina</button>');
    if (s === 'gepubliceerd') knoppen.push(`<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${TRAINING}/${esc(d.slug)}">Live ↗</a><button class="btn btn-ghost btn-sm" onclick="__cmWbDepubliceer()">Offline halen</button>`);
    knoppen.push('<button class="btn btn-ghost btn-sm" onclick="__cmWbKopieer()">Kopieer teksten</button>');
    knoppen.push(typeof window.__cmSocialZip === 'function'
      ? '<button class="btn btn-ghost btn-sm" onclick="__cmSocialZip()">Download alle beelden (zip)</button>'
      : '<button class="btn btn-ghost btn-sm" disabled title="Volgt met de social-rendering">Download beelden (zip)</button>');
    if (['gegenereerd', 'goedgekeurd'].includes(s)) knoppen.push('<button class="btn btn-ghost btn-sm" onclick="__cmWbBewerkInvoer()">Invoer aanpassen</button><button class="btn btn-ghost btn-sm" onclick="__cmWbAllesOpnieuw()">↻ Alles opnieuw</button>');
    const versies = (wb.versies || []).filter((v) => v.versie !== d.versie);
    if (versies.length && ['gegenereerd', 'goedgekeurd'].includes(s)) {
      knoppen.push(`<select class="ib-input cm-mini" style="width:auto" onchange="__cmWbVersieTerug(this.value);this.value=''"><option value="">Versie v${d.versie} · terugzetten…</option>${versies.map((v) => `<option value="${v.versie}">v${v.versie} · ${esc(fmtTijd(v.aangemaakt_op))} · ${esc(v.reden || '')}</option>`).join('')}</select>`);
    }
    return knoppen.join('');
  }

  function waarschuwingenHtml() {
    const w = ((wb.output || {}).meta || {}).waarschuwingen || [];
    if (!w.length) return '';
    const grens = w.filter((x) => x.soort === 'grens');
    const rest = w.filter((x) => x.soort !== 'grens');
    return `<div class="card" style="margin-bottom:10px;border-color:${grens.length ? 'var(--rose)' : 'var(--amber)'}"><div class="card-body" style="font-size:12px">
      ${grens.length ? `<div style="color:var(--rose);font-weight:700;margin-bottom:4px">Niet goedkeurbaar — pas deze teksten aan:</div><ul style="margin:0 0 6px 18px">${grens.map((x) => `<li>${esc(x.tekst)}${x.fragment ? ` <span style="color:var(--text-3)">"${esc(x.fragment)}"</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${rest.length ? `<div style="color:var(--amber);font-weight:700;margin-bottom:4px">Aandachtspunten</div><ul style="margin:0 0 0 18px">${rest.map((x) => `<li>${esc(x.tekst)}</li>`).join('')}</ul>` : ''}
      ${grens.length ? '<div style="color:var(--text-3);margin-top:4px">De lijst wordt bijgewerkt bij Bewaar wijzigingen.</div>' : ''}</div></div>`;
  }

  // Social 2.0 (varianten zoals de Instagram-reeks): editors uit contentmachine-social2-v2.js.
  const EDITORS = {
    pagina: paginaEditor, nieuwsbrief: nieuwsbriefEditor,
    stories: () => (s2() ? window.__cmSocial2.editor('stories') : storiesEditor()),
    post: () => (s2() ? window.__cmSocial2.editor('post') : postEditor()),
    linkedin: () => (s2() ? window.__cmSocial2.editor('linkedin') : linkedinEditor()),
  };

  const CSS = `<style>
    .cm-wb-kol{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:12px;align-items:start}
    @media (max-width:1100px){.cm-wb-kol{grid-template-columns:1fr}}
    .cm-wb-groep{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--surface,#fff)}
    .cm-wb-groep-kop{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2);margin-bottom:8px}
    .cm-wb-sub{border-top:1px dashed var(--border);padding-top:8px;margin-top:8px}
    .cm-wb-mini{width:52px;height:52px;border-radius:8px;overflow:hidden;background:var(--surface-3,#E9EDF2);display:flex;align-items:center;justify-content:center;flex:0 0 52px;color:var(--text-3)}
    .cm-wb-mini img{width:100%;height:100%;object-fit:cover}
    .cm-wb-frame{width:100%;border:1px solid var(--border);border-radius:10px;background:#0B1E2A}
    .cm-wb-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;border-bottom:1px solid var(--border)}
    .cm-wb-tab{border:0;background:none;padding:8px 12px;font-size:13px;font-weight:600;color:var(--text-3);cursor:pointer;border-bottom:2px solid transparent}
    .cm-wb-tab.aan{color:var(--text);border-bottom-color:var(--m,#6D3FD4)}
    .cm-sv-rij{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px}
    .cm-sv{position:relative;flex:0 0 auto;background:linear-gradient(180deg,#112B3B,#0B1E2A);color:#fff;border-radius:12px;padding:14px;overflow:hidden;font-family:Inter,Arial,sans-serif;display:flex;flex-direction:column;justify-content:flex-end}
    .cm-sv-story{width:180px;aspect-ratio:9/16}.cm-sv-post{width:200px;aspect-ratio:4/5}.cm-sv-vierkant{width:220px;aspect-ratio:1}
    .cm-sv-img{position:absolute;inset:0;width:100%;height:55%;object-fit:cover;opacity:.85;border-radius:0}
    .cm-sv-k{position:relative;color:#D0A050;font-size:9px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
    .cm-sv-t{position:relative;font-size:16px;line-height:1.05;font-weight:900;margin-top:4px}
    .cm-sv-x{position:relative;font-size:10.5px;color:#D9E3E8;margin-top:4px;max-height:7em;overflow:hidden}
    .cm-sv-sticker{position:relative;margin-top:8px;background:#fff;color:#0B1E2A;border-radius:8px;padding:4px 8px;font-size:10px;font-weight:700;align-self:flex-start}
  </style>`;

  /** Het werkblad (aangeroepen door contentmachine-v2.js). */
  window.__cmWerkbladView = function () {
    if (wb.bezig === 'alles') {
      return `${CSS}<div class="card"><div class="card-body" style="text-align:center;padding:40px 18px">
        <div style="font-size:28px">✨</div><div style="font-size:15px;font-weight:700;margin-top:6px">De machine maakt je drop…</div>
        <div style="color:var(--text-3);font-size:12.5px;margin-top:4px;max-width:440px;margin-left:auto;margin-right:auto">Format kiezen, pagina, nieuwsbrief, stories, post en LinkedIn schrijven, controleren op de grenzen en vergelijken met de vorige drops. Dit duurt 1 à 3 minuten — laat dit tabblad open.</div></div></div>`;
    }
    if (wb.laden || !wb.drop || !wb.output) return '<div style="color:var(--text-3);font-size:12.5px">Werkblad laden…</div>';
    const d = wb.drop; const o = wb.output;
    const [c, l] = STATUS[d.status] || ['neutral', d.status];
    const kop = `<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="__cmWbSluit()">← Alle drops</button>
      <div style="min-width:0;flex:1"><div style="font-size:18px;font-weight:700"><span style="font-family:var(--mono,monospace)">${esc(d.slug)}</span> ${pill(c, l)} ${d.soort === 'training' ? pill('accent', 'Training') : pill('neutral', 'Update')} ${o.format_key ? pill('neutral', FORMATS[o.format_key] || o.format_key) : ''}</div>
        <div style="color:var(--text-2);font-size:12.5px;margin-top:2px">${esc(o.kernidee || '')}</div>
        <div style="color:var(--text-3);font-size:11px;margin-top:2px">v${d.versie}${o.meta && o.meta.model ? ' · ' + esc(o.meta.model) : ''}${d.gepubliceerd_op ? ' · gepubliceerd ' + esc(fmtTijd(d.gepubliceerd_op)) : ''}</div></div>
      <div id="cm-wb-acties" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${actiesHtml()}</div></div>`;
    const tabs = `<div class="cm-wb-tabs">${TABS.map(([k, lab]) => `<button class="cm-wb-tab ${wb.tab === k ? 'aan' : ''}" onclick="__cmWbTab('${k}')">${lab}</button>`).join('')}</div>`;
    const bewerkbaar = ['gegenereerd', 'goedgekeurd'].includes(d.status);
    const editor = bewerkbaar ? `${regenBalk(wb.tab)}${EDITORS[wb.tab]()}` : `<div class="card"><div class="card-body" style="font-size:12.5px;color:var(--text-2)">Deze drop is ${esc(l.toLowerCase())}: teksten zijn vergrendeld.${d.status === 'gepubliceerd' ? ' Haal hem offline om aan te passen.' : ''}</div></div>`;
    return `${CSS}${kop}${waarschuwingenHtml()}${tabs}<div id="cm-wb-kiezer">${kiezerHtml()}</div>
      <div class="cm-wb-kol"><div>${editor}</div><div style="position:sticky;top:8px"><div id="cm-wb-voorbeeld">${voorbeeldHtml()}</div></div></div>`;
  };

  window.__cmWerkblad = wb;
  // Hulpstukken voor de Weekeditie-editor (contentmachine-weekeditie-v2.js).
  window.__cmWbHulp = { haal, zetPad, markeer, veld, beeldVeld, groep, esc, pill, rerender, teken, post, api, toast, foutTekst, zet, kloon, assetMap, regenHtml, laadNbVoorbeeld: () => laadNbVoorbeeld() };
})();
