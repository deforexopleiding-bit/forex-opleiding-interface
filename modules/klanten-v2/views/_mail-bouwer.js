// modules/klanten-v2/views/_mail-bouwer.js
//
// Mailbouwer (2026-10-11): een e-mailsjabloon opbouwen uit BLOKKEN — kop,
// tekst, knop, afbeelding (upload), twee kolommen, scheidingslijn, ruimte.
// Blok toevoegen, slepen of ↑/↓ om de volgorde te wisselen, ✕ om te
// verwijderen; per blok een klein instelpaneel; live voorbeeld in de
// huisstijl met een schakelaar desktop/mobiel.
//
// De compiler + huisstijl zijn dezelfde bestanden als op de server
// (modules/shared/mail-blokken.js + mail-huisstijl.js, via index.html als
// window.MailBlokken / window.MailHuisstijl): voorbeeld = verzonden mail. Bij
// opslaan stuurt de bouwer alleen de BLOKKEN (JSON); de server compileert zelf.
//
// Opent als eigen venster op document.body (boven de popups). Gebruik:
//   window.MailBouwer.open({ sjabloon:{id?,naam,onderwerp,blokken?,html?}, onOpgeslagen })

(function () {
  'use strict';
  const ROOT_ID = 'mailBouwerRoot';
  const VARS = ['voornaam', 'achternaam', 'naam', 'email', 'boekingslink'];
  const VOORBEELD_VARS = { voornaam: 'Jeffrey', achternaam: 'Biemold', naam: 'Jeffrey Biemold', email: 'jeffrey@voorbeeld.nl', boekingslink: 'https://www.deforexopleiding.nl/agenda' };
  const MAX_UPLOAD = 2 * 1024 * 1024;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let st = null;
  let voorbeeldTimer = null;

  const MB = () => window.MailBlokken;
  const MH = () => window.MailHuisstijl;

  // ── Helpers (puur; getest) ────────────────────────────────────────────────
  /** Voorbeeldwaarden invullen (alleen voor het voorbeeld). */
  function vulVoorbeeld(html) {
    return String(html || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in VOORBEELD_VARS ? esc(VOORBEELD_VARS[k]) : m));
  }
  /** Element verplaatsen in een lijst. */
  function verplaats(lijst, van, naar) {
    const l = lijst.slice();
    if (van < 0 || van >= l.length || naar < 0 || naar >= l.length || van === naar) return l;
    const [x] = l.splice(van, 1);
    l.splice(naar, 0, x);
    return l;
  }
  function samenvatting(b) {
    const tekst = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    switch (b.soort) {
      case 'kop': return b.tekst;
      case 'tekst': return tekst(b.html);
      case 'knop': return b.tekst + ' → ' + b.url;
      case 'afbeelding': return b.url ? (b.alt || 'afbeelding') : 'nog geen afbeelding';
      case 'kolommen': return tekst(b.links && b.links.html) + ' | ' + tekst(b.rechts && b.rechts.html);
      case 'lijn': return b.kleur === 'goud' ? 'goud' : 'grijs';
      case 'ruimte': return b.hoogte + ' px';
      default: return '';
    }
  }

  function toast(msg, ok) {
    try { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(msg, { duration: ok ? 4500 : 9000 }); } catch (_) { /* noop */ }
  }
  async function api(url, init) {
    if (!window.KV || typeof window.KV.authedFetch !== 'function') throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await window.KV.authedFetch(url, init);
    let j = null;
    try { j = await resp.json(); } catch (_) { j = null; }
    if (!resp.ok) { const e = new Error((j && j.error) || ('HTTP ' + resp.status)); e.status = resp.status; e.body = j; throw e; }
    return j;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function root() { return document.getElementById(ROOT_ID); }
  const q = (sel) => { const r = root(); return r ? r.querySelector(sel) : null; };

  function blokkenLijstHtml() {
    const soorten = MB().BLOK_SOORTEN;
    const toevoegen = Object.entries(soorten).map(([k, l]) => `<button type="button" class="btn btn-ghost btn-sm" data-mbw-voeg="${k}" style="justify-content:flex-start">+ ${esc(l)}</button>`).join('');
    const kaarten = st.blokken.map((b, i) => `
      <div data-mbw-kaart="${i}" draggable="true" style="display:flex;gap:6px;align-items:center;padding:7px 8px;margin-bottom:6px;border:1px solid ${i === st.gekozen ? 'var(--accent,#10284A)' : 'var(--border)'};border-radius:8px;background:${i === st.gekozen ? 'var(--surface-2,#f1f4f8)' : 'var(--surface,#fff)'};cursor:pointer">
        <span title="Slepen om te verplaatsen" style="cursor:grab;color:var(--text-3)">⋮⋮</span>
        <div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:600">${esc(soorten[b.soort] || b.soort)}</div>
          <div data-mbw-sam="${i}" style="font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(samenvatting(b))}</div></div>
        <button type="button" class="btn btn-ghost btn-sm" data-mbw-op="${i}" title="Omhoog" style="padding:0 5px" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn btn-ghost btn-sm" data-mbw-neer="${i}" title="Omlaag" style="padding:0 5px" ${i === st.blokken.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn btn-ghost btn-sm" data-mbw-weg="${i}" title="Verwijderen" style="padding:0 5px;color:var(--rose)">✕</button>
      </div>`).join('');
    return `<div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">Blok toevoegen</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:12px">${toevoegen}</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">Blokken (${st.blokken.length})</div>
      ${kaarten || '<div style="font-size:12px;color:var(--text-3)">Nog geen blokken.</div>'}`;
  }

  const veld = (label, inner) => `<label style="display:block;font-size:11.5px;color:var(--text-3);margin-bottom:8px">${esc(label)}<div style="margin-top:3px">${inner}</div></label>`;
  const keuze = (sleutel, waarde, opties) => `<select class="ib-input" data-mbw-veld="${sleutel}" style="width:100%">${opties.map(([v, l]) => `<option value="${v}" ${String(waarde) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const invoer = (sleutel, waarde, extra = '') => `<input class="ib-input" data-mbw-veld="${sleutel}" value="${esc(waarde)}" style="width:100%" ${extra}>`;
  const UITLIJNING = [['left', 'Links'], ['center', 'Midden'], ['right', 'Rechts']];
  const varKnoppen = (doel) => `<div style="display:flex;flex-wrap:wrap;gap:3px;margin:4px 0">${VARS.map((v) => `<button type="button" class="btn btn-ghost btn-sm" data-mbw-var="${v}" data-mbw-doel="${doel}" style="padding:1px 5px;font-size:10.5px">{{${v}}}</button>`).join('')}</div>`;
  const rijkeEditor = (sleutel, html) => `
    <div style="display:flex;gap:2px;flex-wrap:wrap;border:1px solid var(--border);border-bottom:0;border-radius:8px 8px 0 0;padding:3px;background:var(--surface-2,#f6f8fa)">
      <button type="button" class="btn btn-ghost btn-sm" data-mbw-cmd="bold" data-mbw-doel="${sleutel}" style="padding:2px 7px"><b>B</b></button>
      <button type="button" class="btn btn-ghost btn-sm" data-mbw-cmd="italic" data-mbw-doel="${sleutel}" style="padding:2px 7px"><i>I</i></button>
      <button type="button" class="btn btn-ghost btn-sm" data-mbw-cmd="underline" data-mbw-doel="${sleutel}" style="padding:2px 7px"><u>U</u></button>
      <button type="button" class="btn btn-ghost btn-sm" data-mbw-cmd="createLink" data-mbw-doel="${sleutel}" style="padding:2px 7px">🔗</button>
      <button type="button" class="btn btn-ghost btn-sm" data-mbw-cmd="insertUnorderedList" data-mbw-doel="${sleutel}" style="padding:2px 7px">•</button>
      <button type="button" class="btn btn-ghost btn-sm" data-mbw-cmd="insertOrderedList" data-mbw-doel="${sleutel}" style="padding:2px 7px">1.</button>
    </div>
    <div data-mbw-rijk="${sleutel}" contenteditable="true" style="min-height:90px;max-height:220px;overflow:auto;padding:8px 10px;border:1px solid var(--border);border-radius:0 0 8px 8px;background:var(--surface,#fff);font-size:13.5px;line-height:1.55;outline:none">${MB().schoonRijkeTekst(html)}</div>
    ${varKnoppen(sleutel)}`;
  const uploadVeld = (sleutel, url) => `
    <div style="display:flex;gap:6px;align-items:center">
      <label class="btn btn-ghost btn-sm" style="cursor:pointer">${st.upload === sleutel ? 'Uploaden…' : 'Afbeelding uploaden'}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-mbw-upload="${sleutel}" style="display:none"></label>
      ${url ? `<img src="${esc(url)}" alt="" style="height:34px;max-width:90px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">` : '<span style="font-size:11px;color:var(--text-3)">PNG/JPEG/GIF/WebP, max 2 MB</span>'}
    </div>`;

  function instellingenHtml() {
    const b = st.blokken[st.gekozen];
    if (!b) return '<div style="font-size:12.5px;color:var(--text-3)">Kies links een blok om het in te stellen, of voeg er een toe.</div>';
    const titel = `<div style="font-weight:600;margin-bottom:10px">${esc(MB().BLOK_SOORTEN[b.soort])}</div>`;
    switch (b.soort) {
      case 'kop': return titel + veld('Tekst', invoer('tekst', b.tekst, 'maxlength="200"')) + veld('Grootte', keuze('niveau', b.niveau, [['h2', 'Groot'], ['h3', 'Middel']])) + veld('Uitlijning', keuze('uitlijning', b.uitlijning, UITLIJNING));
      case 'tekst': return titel + rijkeEditor('html', b.html) + veld('Uitlijning', keuze('uitlijning', b.uitlijning, UITLIJNING));
      case 'knop': return titel + veld('Tekst op de knop', invoer('tekst', b.tekst, 'maxlength="80"'))
        + veld('Link', invoer('url', b.url, 'placeholder="https://… of {{boekingslink}}"') + varKnoppen('url'))
        + veld('Kleur', keuze('stijl', b.stijl, [['navy', 'Navy (wit tekst)'], ['goud', 'Goud (navy tekst)']])) + veld('Uitlijning', keuze('uitlijning', b.uitlijning, UITLIJNING));
      case 'afbeelding': return titel + veld('Afbeelding', uploadVeld('url', b.url))
        + veld('Of een https-adres', invoer('url', b.url, 'placeholder="https://…"'))
        + veld('Omschrijving (alt-tekst)', invoer('alt', b.alt, 'maxlength="200"'))
        + veld(`Breedte (${b.breedte}%)`, `<input type="range" min="20" max="100" step="5" data-mbw-veld="breedte" value="${esc(b.breedte)}" style="width:100%">`)
        + veld('Link bij klikken (optioneel)', invoer('link', b.link, 'placeholder="https://…"')) + veld('Uitlijning', keuze('uitlijning', b.uitlijning, UITLIJNING));
      case 'kolommen': return titel + ['links', 'rechts'].map((kant) => `<div style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px">${kant === 'links' ? 'Linker kolom' : 'Rechter kolom'}</div>
          ${veld('Afbeelding (optioneel)', uploadVeld(kant + '.afbeelding', b[kant].afbeelding))}
          ${b[kant].afbeelding ? veld('Alt-tekst', invoer(kant + '.alt', b[kant].alt, 'maxlength="200"')) + `<button type="button" class="btn btn-ghost btn-sm" data-mbw-wisbeeld="${kant}" style="margin:-4px 0 8px">Afbeelding weghalen</button>` : ''}
          ${rijkeEditor(kant + '.html', b[kant].html)}</div>`).join('') + '<div style="font-size:11px;color:var(--text-3)">Op een telefoon komen de kolommen onder elkaar.</div>';
      case 'lijn': return titel + veld('Kleur', keuze('kleur', b.kleur, [['grijs', 'Grijs (dun)'], ['goud', 'Goud']]));
      case 'ruimte': return titel + veld(`Hoogte (${b.hoogte} px)`, `<input type="range" min="8" max="80" step="4" data-mbw-veld="hoogte" value="${esc(b.hoogte)}" style="width:100%">`);
      default: return titel;
    }
  }

  function voorbeeldSrc() {
    const body = vulVoorbeeld(MB().compileerBlokken(st.blokken));
    return MH().renderLeadMail({ bodyHtml: body });
  }
  function repaintVoorbeeld() {
    const f = q('[data-mbw-voorbeeld]');
    if (f) f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">${voorbeeldSrc()}</body></html>`;
    const fouten = MB().normaliseerBlokken(st.blokken).fouten;
    const fl = q('[data-mbw-fouten]');
    if (fl) fl.innerHTML = fouten.length ? fouten.map((x) => `<div>• ${esc(x)}</div>`).join('') : '';
    const sp = q('[data-mbw-opslaan]');
    if (sp) sp.disabled = !!(st.bezig || fouten.length || !String(st.naam || '').trim() || !String(st.onderwerp || '').trim());
  }
  function planVoorbeeld() { clearTimeout(voorbeeldTimer); voorbeeldTimer = setTimeout(() => { if (st) repaintVoorbeeld(); }, 150); }
  function repaintLijst() { const l = q('[data-mbw-lijst]'); if (l) l.innerHTML = blokkenLijstHtml(); }
  function repaintInstellingen() { const p = q('[data-mbw-instel]'); if (p) p.innerHTML = instellingenHtml(); }
  function repaintSamenvatting(i) { const s = q(`[data-mbw-sam="${i}"]`); if (s && st.blokken[i]) s.textContent = samenvatting(st.blokken[i]); }

  function render() {
    const r = root();
    if (!r || !st) return;
    const box = r.querySelector('[data-mbw-box]');
    const breed = st.weergave === 'mobiel' ? 390 : 640;
    box.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="font-weight:600;font-size:15px;white-space:nowrap">Mailbouwer</div>
        <input class="ib-input" data-mbw-meta="naam" value="${esc(st.naam)}" placeholder="Naam van het sjabloon (intern)" maxlength="120" style="flex:1;min-width:120px">
        <input class="ib-input" data-mbw-meta="onderwerp" value="${esc(st.onderwerp)}" placeholder="Onderwerp (mag {{voornaam}} bevatten)" maxlength="200" style="flex:1.4;min-width:160px">
        ${st.startlayouts ? `<button type="button" class="btn btn-ghost btn-sm" data-mbw-actie="layouts">Startlayout…</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-mbw-actie="sluit">Annuleren</button>
        <button type="button" class="btn btn-primary btn-sm" data-mbw-opslaan data-mbw-actie="opslaan">${st.bezig ? 'Opslaan…' : 'Opslaan'}</button>
      </div>
      <div style="display:grid;grid-template-columns:250px 320px minmax(0,1fr);flex:1;min-height:0">
        <div data-mbw-lijst style="padding:12px;overflow:auto;border-right:1px solid var(--border)">${blokkenLijstHtml()}</div>
        <div data-mbw-instel style="padding:12px;overflow:auto;border-right:1px solid var(--border)">${instellingenHtml()}</div>
        <div style="display:flex;flex-direction:column;min-height:0;background:var(--surface-2,#eef1f5)">
          <div style="display:flex;gap:6px;align-items:center;padding:8px 12px">
            <span style="font-size:12px;color:var(--text-3)">Voorbeeld (met voorbeeldnaam Jeffrey):</span>
            <button type="button" class="btn btn-sm ${st.weergave === 'desktop' ? 'btn-primary' : 'btn-ghost'}" data-mbw-weergave="desktop">Desktop</button>
            <button type="button" class="btn btn-sm ${st.weergave === 'mobiel' ? 'btn-primary' : 'btn-ghost'}" data-mbw-weergave="mobiel">Mobiel</button>
            <span style="margin-left:auto;font-size:11px;color:var(--text-3)">Onder de mail komt bij massa automatisch de afmeldregel.</span>
          </div>
          <div data-mbw-fouten style="font-size:12px;color:var(--rose);padding:0 12px"></div>
          <div style="flex:1;overflow:auto;padding:8px 12px 16px;display:flex;justify-content:center">
            <iframe data-mbw-voorbeeld title="Voorbeeld" sandbox="" style="width:${breed}px;max-width:100%;height:100%;min-height:520px;border:1px solid var(--border);border-radius:10px;background:#eef1f5"></iframe>
          </div>
        </div>
      </div>
      ${st.fout ? `<div style="padding:8px 16px;color:var(--rose);font-size:12.5px;border-top:1px solid var(--border)">${esc(st.fout)}</div>` : ''}
      ${st.toonLayouts ? layoutsHtml() : ''}`;
    repaintVoorbeeld();
  }

  function layoutsHtml() {
    const l = st.startlayouts || [];
    return `<div data-mbw-layouts style="position:absolute;inset:0;background:rgba(10,20,35,.35);display:flex;align-items:center;justify-content:center;border-radius:14px">
      <div style="background:var(--surface,#fff);border-radius:12px;padding:16px;max-width:560px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.2)">
        <div style="font-weight:600;margin-bottom:4px">Begin met een startlayout</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">De huidige blokken worden vervangen; alles blijft bewerkbaar.</div>
        ${l.map((x) => `<button type="button" class="btn btn-ghost" data-mbw-layout="${esc(x.sleutel)}" style="display:block;width:100%;text-align:left;margin-bottom:6px;padding:8px 10px"><b>${esc(x.naam)}</b><div style="font-size:12px;color:var(--text-3)">${esc(x.omschrijving)}</div></button>`).join('')}
        <div style="text-align:right;margin-top:6px"><button type="button" class="btn btn-ghost btn-sm" data-mbw-actie="layouts-dicht">Sluiten</button></div>
      </div></div>`;
  }

  // ── Bewerken ──────────────────────────────────────────────────────────────
  function zetVeld(b, sleutel, waarde) {
    const delen = String(sleutel).split('.');
    if (delen.length === 2) { b[delen[0]] = { ...b[delen[0]], [delen[1]]: waarde }; return; }
    b[sleutel] = ['breedte', 'hoogte'].includes(sleutel) ? Number(waarde) : waarde;
  }
  function bewaarRijk() {
    const r = root(); if (!r || !st) return;
    const b = st.blokken[st.gekozen]; if (!b) return;
    r.querySelectorAll('[data-mbw-rijk]').forEach((el) => zetVeld(b, el.getAttribute('data-mbw-rijk'), el.innerHTML));
  }

  async function uploadBestand(sleutel, bestand) {
    if (!bestand) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(bestand.type)) { toast('Alleen PNG, JPEG, GIF of WebP.', false); return; }
    if (bestand.size > MAX_UPLOAD) { toast('De afbeelding is groter dan 2 MB.', false); return; }
    const index = st.gekozen;
    st.upload = sleutel; repaintInstellingen();
    try {
      const data = await new Promise((ok, nok) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result || '')); fr.onerror = () => nok(new Error('Lezen mislukt')); fr.readAsDataURL(bestand); });
      const j = await api('/api/mail-afbeelding-upload', { method: 'POST', body: JSON.stringify({ bestandsnaam: bestand.name, content_type: bestand.type, data_base64: data.split(',')[1] || '' }) });
      if (!st) return;
      const b = st.blokken[index];
      if (b) zetVeld(b, sleutel, j.url);
      toast('Afbeelding geüpload', true);
    } catch (e) {
      console.error('[mail-bouwer] upload mislukt:', e && e.status, e && (e.body || e.message));
      toast('Uploaden mislukt: ' + ((e && e.message) || 'onbekend'), false);
    }
    if (!st) return;
    st.upload = null;
    repaintInstellingen(); repaintSamenvatting(index); planVoorbeeld();
  }

  async function opslaan() {
    bewaarRijk();
    const n = MB().normaliseerBlokken(st.blokken);
    if (n.fouten.length || !String(st.naam || '').trim() || !String(st.onderwerp || '').trim()) { repaintVoorbeeld(); return; }
    st.bezig = true; st.fout = null; repaintVoorbeeld();
    try {
      const j = await api('/api/lead-mail-sjablonen', { method: 'POST', body: JSON.stringify({ id: st.id || undefined, naam: st.naam, onderwerp: st.onderwerp, blokken: n.blokken }) });
      if (!st) return;
      toast('Sjabloon "' + st.naam + '" opgeslagen', true);
      const klaar = st.onOpgeslagen;
      sluit();
      if (typeof klaar === 'function') { try { klaar(j && j.sjabloon); } catch (_) { /* noop */ } }
    } catch (e) {
      if (!st) return;
      console.error('[mail-bouwer] opslaan mislukt:', e && e.status, e && (e.body || e.message));
      st.bezig = false; st.fout = (e && e.message) || 'Opslaan mislukt'; render();
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function onClick(e) {
    if (!st) return;
    const t = e.target;
    const cmd = t.closest('[data-mbw-cmd]');
    if (cmd) {
      const ed = q(`[data-mbw-rijk="${cmd.getAttribute('data-mbw-doel')}"]`); if (ed) ed.focus();
      const c = cmd.getAttribute('data-mbw-cmd');
      if (c === 'createLink') {
        const url = window.prompt('Link-adres (https://… of {{boekingslink}}):', 'https://');
        if (url && /^(https?:\/\/|mailto:|\{\{\s*\w+\s*\}\})/i.test(url.trim())) document.execCommand('createLink', false, url.trim());
      } else document.execCommand(c, false, null);
      bewaarRijk(); repaintSamenvatting(st.gekozen); planVoorbeeld(); return;
    }
    const v = t.closest('[data-mbw-var]');
    if (v) {
      const doel = v.getAttribute('data-mbw-doel');
      const token = '{{' + v.getAttribute('data-mbw-var') + '}}';
      const rijk = q(`[data-mbw-rijk="${doel}"]`);
      if (rijk) { rijk.focus(); document.execCommand('insertText', false, token); bewaarRijk(); }
      else { const b = st.blokken[st.gekozen]; if (b) { zetVeld(b, doel, token); repaintInstellingen(); } }
      repaintSamenvatting(st.gekozen); planVoorbeeld(); return;
    }
    const voeg = t.closest('[data-mbw-voeg]');
    if (voeg) {
      bewaarRijk();
      const nieuw = MB().maakBlok(voeg.getAttribute('data-mbw-voeg'));
      const plek = st.gekozen >= 0 ? st.gekozen + 1 : st.blokken.length;
      st.blokken.splice(plek, 0, nieuw); st.gekozen = plek;
      repaintLijst(); repaintInstellingen(); planVoorbeeld(); return;
    }
    const knop = (attr) => t.closest(`[${attr}]`);
    let k;
    if ((k = knop('data-mbw-op')) || (k = knop('data-mbw-neer'))) {
      bewaarRijk();
      const i = Number(k.getAttribute(k.hasAttribute('data-mbw-op') ? 'data-mbw-op' : 'data-mbw-neer'));
      const naar = k.hasAttribute('data-mbw-op') ? i - 1 : i + 1;
      st.blokken = verplaats(st.blokken, i, naar); st.gekozen = naar;
      repaintLijst(); repaintInstellingen(); planVoorbeeld(); return;
    }
    if ((k = knop('data-mbw-weg'))) {
      bewaarRijk();
      const i = Number(k.getAttribute('data-mbw-weg'));
      st.blokken.splice(i, 1); st.gekozen = Math.min(st.gekozen, st.blokken.length - 1);
      repaintLijst(); repaintInstellingen(); planVoorbeeld(); return;
    }
    if ((k = knop('data-mbw-kaart'))) {
      bewaarRijk();
      st.gekozen = Number(k.getAttribute('data-mbw-kaart'));
      repaintLijst(); repaintInstellingen(); return;
    }
    if ((k = knop('data-mbw-wisbeeld'))) {
      const b = st.blokken[st.gekozen]; const kant = k.getAttribute('data-mbw-wisbeeld');
      if (b && b[kant]) { b[kant] = { ...b[kant], afbeelding: '', alt: '' }; repaintInstellingen(); planVoorbeeld(); }
      return;
    }
    if ((k = knop('data-mbw-weergave'))) { bewaarRijk(); st.weergave = k.getAttribute('data-mbw-weergave'); render(); return; }
    if ((k = knop('data-mbw-layout'))) {
      const x = (st.startlayouts || []).find((l) => l.sleutel === k.getAttribute('data-mbw-layout'));
      if (x) {
        st.blokken = x.blokken().map((b) => ({ ...b, id: MB().maakBlok(b.soort).id }));
        if (!String(st.onderwerp || '').trim()) st.onderwerp = x.onderwerp;
        if (!String(st.naam || '').trim()) st.naam = x.naam;
        st.gekozen = 0; st.toonLayouts = false; render();
      }
      return;
    }
    const a = t.closest('[data-mbw-actie]');
    if (!a || a.disabled) return;
    const actie = a.getAttribute('data-mbw-actie');
    if (actie === 'sluit') { if (!st.bezig) sluit(); }
    else if (actie === 'opslaan') opslaan();
    else if (actie === 'layouts') { bewaarRijk(); st.toonLayouts = true; render(); }
    else if (actie === 'layouts-dicht') { st.toonLayouts = false; render(); }
  }
  function onInput(e) {
    if (!st) return;
    const el = e.target;
    const meta = el.getAttribute && el.getAttribute('data-mbw-meta');
    if (meta) { st[meta] = el.value; repaintVoorbeeld(); return; }
    const sleutel = el.getAttribute && el.getAttribute('data-mbw-veld');
    if (sleutel) {
      const b = st.blokken[st.gekozen]; if (!b) return;
      zetVeld(b, sleutel, el.value);
      if (sleutel === 'breedte' || sleutel === 'hoogte') { const lab = el.closest('label'); if (lab && lab.firstChild) lab.firstChild.textContent = (sleutel === 'breedte' ? `Breedte (${el.value}%)` : `Hoogte (${el.value} px)`); }
      repaintSamenvatting(st.gekozen); planVoorbeeld(); return;
    }
    if (el.matches && el.matches('[data-mbw-rijk]')) { bewaarRijk(); repaintSamenvatting(st.gekozen); planVoorbeeld(); }
  }
  function onChange(e) {
    if (!st) return;
    const el = e.target;
    const up = el.getAttribute && el.getAttribute('data-mbw-upload');
    if (up) { uploadBestand(up, el.files && el.files[0]); el.value = ''; return; }
    if (el.tagName === 'SELECT') onInput(e);
  }
  function onPaste(e) {
    if (!e.target.closest || !e.target.closest('[data-mbw-rijk]')) return;
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
  }
  let sleepVan = -1;
  function onDragStart(e) { const k = e.target.closest && e.target.closest('[data-mbw-kaart]'); if (!k) return; bewaarRijk(); sleepVan = Number(k.getAttribute('data-mbw-kaart')); try { e.dataTransfer.setData('text/plain', String(sleepVan)); } catch (_) { /* noop */ } }
  function onDragOver(e) { if (sleepVan >= 0 && e.target.closest && e.target.closest('[data-mbw-kaart]')) e.preventDefault(); }
  function onDrop(e) {
    const k = e.target.closest && e.target.closest('[data-mbw-kaart]');
    if (!k || sleepVan < 0) return;
    e.preventDefault();
    const naar = Number(k.getAttribute('data-mbw-kaart'));
    st.blokken = verplaats(st.blokken, sleepVan, naar); st.gekozen = naar; sleepVan = -1;
    repaintLijst(); repaintInstellingen(); planVoorbeeld();
  }
  function onKey(e) { if (e.key === 'Escape' && st && !st.bezig && !st.toonLayouts) { e.preventDefault(); e.stopPropagation(); sluit(); } }

  function sluit() {
    const r = root(); if (r) r.remove();
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(voorbeeldTimer);
    st = null;
  }

  /**
   * opts.sjabloon   — { id?, naam, onderwerp, blokken?, html? } (html zonder blokken → één tekstblok)
   * opts.onOpgeslagen(sjabloon)
   */
  function open(opts) {
    const o = opts || {};
    if (!MB() || !MH()) { toast('De mailbouwer is nog niet geladen — probeer het zo opnieuw.', false); return; }
    sluit();
    const s = o.sjabloon || {};
    const blokken = Array.isArray(s.blokken) && s.blokken.length
      ? JSON.parse(JSON.stringify(s.blokken))
      : (s.html ? MB().blokkenUitHtml(s.html) : []);
    st = {
      id: s.id || null, naam: s.naam || '', onderwerp: s.onderwerp || '', blokken,
      gekozen: blokken.length ? 0 : -1, weergave: 'desktop', upload: null, bezig: false, fout: null,
      startlayouts: Array.isArray(window.MailStartlayouts) ? window.MailStartlayouts : null,
      toonLayouts: !s.id && !blokken.length && Array.isArray(window.MailStartlayouts),
      onOpgeslagen: o.onOpgeslagen,
    };
    const r = document.createElement('div');
    r.id = ROOT_ID;
    r.setAttribute('style', 'position:fixed;inset:0;z-index:9600;background:rgba(10,20,35,.5);display:flex;align-items:center;justify-content:center;padding:12px');
    r.innerHTML = '<div data-mbw-box role="dialog" aria-modal="true" aria-label="Mailbouwer" style="position:relative;background:var(--surface,#fff);color:var(--text,#1b2430);width:100%;max-width:1320px;height:94vh;display:flex;flex-direction:column;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3)"></div>';
    r.addEventListener('click', onClick);
    r.addEventListener('input', onInput);
    r.addEventListener('change', onChange);
    r.addEventListener('paste', onPaste);
    r.addEventListener('dragstart', onDragStart);
    r.addEventListener('dragover', onDragOver);
    r.addEventListener('drop', onDrop);
    document.body.appendChild(r);
    document.addEventListener('keydown', onKey, true);
    render();
  }

  window.MailBouwer = { open, sluit, _intern: { vulVoorbeeld, verplaats, samenvatting, staat: () => st } };
})();
