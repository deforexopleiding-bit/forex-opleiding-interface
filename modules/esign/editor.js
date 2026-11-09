// modules/esign/editor.js — envelope samenstellen (ingelogd, recht esign.send)
//
// Stap 1 Gegevens: titel, bericht, volgorde, ondertekenaars (teamleden),
//         optioneel een klant koppelen, PDF uploaden (rechtstreeks naar de
//         privé-bucket via een signed upload-URL; de server controleert daarna
//         dat het een leesbare PDF is en rekent de SHA-256 uit).
// Stap 2 Velden: kies een ondertekenaar en een veldtype, klik op de pagina om
//         te plaatsen; slepen = verplaatsen, hoekje = vergroten, × = weg.
//         Posities worden als fracties bewaard (esign-coords.js).
// Stap 3 Versturen: controle + versturen.

import { toonPdf } from './pdf-weergave.js';
import { STANDAARD_MAAT_PT, fractieNaarPx, pxNaarFractie } from './esign-coords.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KLEUREN = ['#2D74D6', '#C2700A', '#07835A', '#9333EA', '#C22B3E', '#0E7490', '#B45309', '#6D3FD4', '#B32B72', '#1F6F43'];
const TYPES = [['handtekening', 'Handtekening'], ['paraaf', 'Paraaf'], ['datum', 'Datum'], ['naam', 'Naam'], ['tekst', 'Tekst'], ['checkbox', 'Vinkje']];
const TYPE_LABEL = Object.fromEntries(TYPES);

const S = {
  id: new URLSearchParams(location.search).get('id') || null,
  env: null, teamleden: [], stap: 1, bestand: null, bezig: false, fout: null,
  klantZoek: [], gekozenOntv: [], koppeling: null, koppelNaam: null,
  velden: [], actiefOntv: null, actiefType: null, geselecteerd: null, pdf: null, opslaanTimer: null, opslagStatus: '',
};
let _seq = 0;

// ── API ─────────────────────────────────────────────────────────────────────
async function api(pad, { method = 'GET', body } = {}) {
  const token = await window.AuthShared.getAccessToken();
  const r = await fetch(pad, {
    method, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {}; try { j = await r.json(); } catch (_) { /* */ }
  if (r.status === 401) { await window.AuthShared.requireAuth(); throw new Error('Niet ingelogd'); }
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}
const post = (body) => api('/api/esign', { method: 'POST', body });

function kleurVan(ontvangerId) {
  const i = (S.env?.ontvangers || []).findIndex((o) => o.id === ontvangerId);
  return KLEUREN[(i < 0 ? 0 : i) % KLEUREN.length];
}

// ── Render ──────────────────────────────────────────────────────────────────
function stappenHtml() {
  const s = [['Gegevens', 1], ['Velden plaatsen', 2], ['Versturen', 3]];
  return `<ol class="stappen">${s.map(([t, n]) => `<li class="${S.stap === n ? 'actief' : S.stap > n ? 'klaar' : ''}"><span class="nr">${S.stap > n ? '✓' : n}</span>${t}</li>`).join('')}</ol>`;
}
function foutHtml() { return S.fout ? `<div class="melding fout" role="alert">${esc(S.fout)}</div>` : ''; }

function render() {
  const main = $('#main');
  if (S.env && S.env.status !== 'concept') {
    main.innerHTML = `<div class="kaart status-groot"><h1>${esc(S.env.titel)}</h1><p class="sub">Deze envelope is al verstuurd (${esc(S.env.status)}) en kan niet meer gewijzigd worden.</p>
      <p><a class="knop knop-navy" href="/modules/klanten-v2/#esign">Naar het overzicht</a></p></div>`;
    return;
  }
  if (S.stap === 1) return renderStap1(main);
  if (S.stap === 2) return renderStap2(main);
  return renderStap3(main);
}

function renderStap1(main) {
  const e = S.env || { titel: '', bericht: '', volgorde: 'sequentieel' };
  const doc = S.env?.documenten?.[0];
  const opties = S.teamleden.filter((t) => !S.gekozenOntv.includes(t.id))
    .map((t) => `<option value="${esc(t.id)}">${esc(t.naam)} — ${esc(t.email)}</option>`).join('');
  const lijst = S.gekozenOntv.map((id, i) => {
    const t = S.teamleden.find((x) => x.id === id) || { naam: '(onbekend)', email: '' };
    return `<div class="ontv"><span class="nr">${i + 1}</span><span class="kleur" style="background:${KLEUREN[i % KLEUREN.length]}"></span>
      <span class="wie">${esc(t.naam)}<small>${esc(t.email)}</small></span>
      <button type="button" class="icoon-knop" data-op="${i}" aria-label="Omhoog" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icoon-knop" data-neer="${i}" aria-label="Omlaag" ${i === S.gekozenOntv.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="icoon-knop" data-weg="${i}" aria-label="Verwijderen">×</button></div>`;
  }).join('');
  main.innerHTML = `${stappenHtml()}
  <div class="kaart">
    <h1>${S.id ? 'Envelope bewerken' : 'Nieuwe envelope'}</h1>
    <p class="sub">Laat een document ondertekenen door een of meer teamleden.</p>
    ${foutHtml()}
    <div style="margin-top:16px">
      <div class="veld"><label for="titel">Titel</label><input type="text" id="titel" maxlength="200" value="${esc(e.titel)}" placeholder="Bijv. Samenwerkingsovereenkomst 2026"></div>
      <div class="veld"><label for="bericht">Bericht in de uitnodiging <span class="hulp">(optioneel)</span></label><textarea id="bericht" maxlength="2000">${esc(e.bericht || '')}</textarea></div>
      <div class="veld"><span class="label">Tekenvolgorde</span>
        <div class="keuze">
          <label><input type="radio" name="volgorde" value="sequentieel" ${e.volgorde !== 'parallel' ? 'checked' : ''}><span><b>Een voor een</b><br><span class="hulp">De volgende krijgt pas een mail als de vorige getekend heeft.</span></span></label>
          <label><input type="radio" name="volgorde" value="parallel" ${e.volgorde === 'parallel' ? 'checked' : ''}><span><b>Tegelijk</b><br><span class="hulp">Iedereen krijgt meteen een mail.</span></span></label>
        </div></div>
      <div class="veld"><span class="label">Ondertekenaars</span>
        <div class="ontv-lijst">${lijst || '<p class="sub">Nog niemand gekozen.</p>'}</div>
        <div style="display:flex;gap:8px"><select id="teamlid" aria-label="Teamlid kiezen"><option value="">Teamlid toevoegen…</option>${opties}</select>
        <button type="button" class="knop knop-licht" id="voegToe">Toevoegen</button></div>
        <span class="hulp">Fase 1: alleen interne teamleden met een CRM-profiel.</span></div>
      <div class="veld"><label for="klantZoek">Koppelen aan een klant <span class="hulp">(optioneel)</span></label>
        ${S.koppeling ? `<div class="ontv"><span class="wie">${esc(S.koppelNaam || 'Gekoppelde klant')}<small>klant</small></span><button type="button" class="icoon-knop" id="ontkoppel" aria-label="Koppeling weghalen">×</button></div>`
          : `<input type="search" id="klantZoek" placeholder="Zoek op naam of e-mail" autocomplete="off"><div class="zoek-uit ${S.klantZoek.length ? '' : 'verborgen'}" id="klantUit">${S.klantZoek.map((k) => `<button type="button" data-klant="${esc(k.id)}" data-naam="${esc(k.naam)}">${esc(k.naam)} <span class="hulp">${esc(k.email || '')}</span></button>`).join('')}</div>`}
      </div>
      <div class="veld"><span class="label">Document (PDF, max. 25 MB)</span>
        ${doc ? `<div class="melding ok">📄 ${esc(doc.naam)} · ${doc.paginas.length} pagina${doc.paginas.length === 1 ? '' : "'s"}. Kies hieronder een ander bestand om het te vervangen (geplaatste velden vervallen dan).</div>` : ''}
        <label class="upload" id="upload" tabindex="0"><input type="file" id="pdfBestand" accept="application/pdf" hidden>
          ${S.bestand ? `Gekozen: <b>${esc(S.bestand.name)}</b>` : 'Sleep een PDF hierheen of <u>kies een bestand</u>'}</label></div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
      <button type="button" class="knop knop-goud" id="verder" ${S.bezig ? 'disabled' : ''}>${S.bezig ? 'Bezig…' : 'Opslaan en velden plaatsen →'}</button>
    </div>
  </div>`;

  $('#voegToe').onclick = () => { const v = $('#teamlid').value; if (v) { bewaarInvoer(); S.gekozenOntv.push(v); render(); } };
  main.querySelectorAll('[data-op]').forEach((b) => { b.onclick = () => { bewaarInvoer(); const i = +b.dataset.op; [S.gekozenOntv[i - 1], S.gekozenOntv[i]] = [S.gekozenOntv[i], S.gekozenOntv[i - 1]]; render(); }; });
  main.querySelectorAll('[data-neer]').forEach((b) => { b.onclick = () => { bewaarInvoer(); const i = +b.dataset.neer; [S.gekozenOntv[i + 1], S.gekozenOntv[i]] = [S.gekozenOntv[i], S.gekozenOntv[i + 1]]; render(); }; });
  main.querySelectorAll('[data-weg]').forEach((b) => { b.onclick = () => { bewaarInvoer(); S.gekozenOntv.splice(+b.dataset.weg, 1); render(); }; });
  const kz = $('#klantZoek');
  if (kz) {
    let t = null;
    kz.oninput = () => { clearTimeout(t); const q = kz.value.trim(); t = setTimeout(async () => {
      if (q.length < 2) { S.klantZoek = []; $('#klantUit').classList.add('verborgen'); return; }
      const seq = ++_seq;
      try { const j = await api('/api/esign?actie=klanten&q=' + encodeURIComponent(q)); if (seq !== _seq) return; S.klantZoek = j.klanten || []; }
      catch (e) { S.klantZoek = []; }
      const uit = $('#klantUit'); if (!uit) return;
      uit.innerHTML = S.klantZoek.map((k) => `<button type="button" data-klant="${esc(k.id)}" data-naam="${esc(k.naam)}">${esc(k.naam)} <span class="hulp">${esc(k.email || '')}</span></button>`).join('') || '<p class="sub" style="padding:8px 12px">Geen klanten gevonden.</p>';
      uit.classList.remove('verborgen');
      uit.querySelectorAll('[data-klant]').forEach((b) => { b.onclick = () => { bewaarInvoer(); S.koppeling = { type: 'klant', id: b.dataset.klant }; S.koppelNaam = b.dataset.naam; S.klantZoek = []; render(); }; });
    }, 250); };
  }
  const ok = $('#ontkoppel'); if (ok) ok.onclick = () => { bewaarInvoer(); S.koppeling = null; S.koppelNaam = null; render(); };
  const up = $('#upload'); const inp = $('#pdfBestand');
  inp.onchange = () => { if (inp.files[0]) { bewaarInvoer(); S.bestand = inp.files[0]; render(); } };
  up.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
  up.ondragover = (e) => { e.preventDefault(); up.classList.add('over'); };
  up.ondragleave = () => up.classList.remove('over');
  up.ondrop = (e) => { e.preventDefault(); up.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) { bewaarInvoer(); S.bestand = f; render(); } };
  $('#verder').onclick = slaStap1Op;
}

let _invoer = null;
function bewaarInvoer() {
  _invoer = {
    titel: $('#titel')?.value ?? _invoer?.titel ?? '',
    bericht: $('#bericht')?.value ?? _invoer?.bericht ?? '',
    volgorde: document.querySelector('input[name=volgorde]:checked')?.value || _invoer?.volgorde || 'sequentieel',
  };
  S.env = { ...(S.env || { status: 'concept', documenten: [], ontvangers: [], velden: [] }), ..._invoer };
}

async function slaStap1Op() {
  bewaarInvoer();
  S.fout = null;
  if (!_invoer.titel.trim()) { S.fout = 'Geef de envelope een titel.'; return render(); }
  if (!S.gekozenOntv.length) { S.fout = 'Kies minstens één ondertekenaar.'; return render(); }
  if (!S.bestand && !S.env?.documenten?.length) { S.fout = 'Kies een PDF.'; return render(); }
  if (S.bestand && S.bestand.size > 25 * 1024 * 1024) { S.fout = 'De PDF is groter dan 25 MB.'; return render(); }
  S.bezig = true; render();
  try {
    const gegevens = { titel: _invoer.titel.trim(), bericht: _invoer.bericht, volgorde: _invoer.volgorde, ontvangers: S.gekozenOntv, entiteit: S.koppeling };
    const j = S.id ? await post({ actie: 'bijwerken', id: S.id, ...gegevens }) : await post({ actie: 'aanmaken', ...gegevens });
    S.env = j.envelope; S.id = j.envelope.id;
    history.replaceState(null, '', '?id=' + encodeURIComponent(S.id));
    if (S.bestand) {
      const u = await post({ actie: 'upload_url', id: S.id, naam: S.bestand.name });
      await uploadNaarBucket(u, S.bestand);
      await post({ actie: 'document_registreren', id: S.id, pad: u.pad, naam: S.bestand.name });
      S.bestand = null;
      S.env = (await api('/api/esign?actie=detail&id=' + encodeURIComponent(S.id))).envelope;
    }
    S.velden = (S.env.velden || []).map((v) => ({ ...v }));
    S.actiefOntv = S.env.ontvangers[0]?.id || null;
    S.stap = 2;
  } catch (e) {
    S.fout = e.message;
  }
  S.bezig = false; render();
}

async function uploadNaarBucket(u, bestand) {
  await window._authSharedReady;
  const sb = window.supabase;
  if (sb && sb.storage && typeof sb.storage.from === 'function') {
    const { error } = await sb.storage.from(u.bucket).uploadToSignedUrl(u.pad, u.token, bestand, { contentType: 'application/pdf' });
    if (error) throw new Error('Upload mislukt: ' + error.message);
    return;
  }
  const r = await fetch(u.signed_url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: bestand });
  if (!r.ok) throw new Error('Upload mislukt (HTTP ' + r.status + ')');
}

// ── Stap 2: velden ──────────────────────────────────────────────────────────
function renderStap2(main) {
  const ontv = S.env.ontvangers;
  main.innerHTML = `${stappenHtml()}
  <div class="editor">
    <aside class="palet">
      <div class="kaart">
        <h2>1. Voor wie?</h2>
        ${ontv.map((o, i) => `<button type="button" class="wie-knop ${S.actiefOntv === o.id ? 'actief' : ''}" data-ontv="${esc(o.id)}"><span class="kleur" style="width:12px;height:12px;border-radius:50%;background:${KLEUREN[i % KLEUREN.length]}"></span><span>${i + 1}. ${esc(o.naam)}<br><small class="hulp">${S.velden.filter((v) => v.ontvanger_id === o.id).length} veld(en)</small></span></button>`).join('')}
        <h2 style="margin-top:14px">2. Welk veld?</h2>
        <div class="types">${TYPES.map(([t, l]) => `<button type="button" class="type ${S.actiefType === t ? 'actief' : ''}" data-type="${t}" aria-pressed="${S.actiefType === t}">${l}</button>`).join('')}</div>
        <p class="hulp" style="margin:10px 0 0;font-size:12.5px">${S.actiefType ? `Klik op de pagina om een <b>${TYPE_LABEL[S.actiefType].toLowerCase()}</b> te plaatsen.` : 'Kies een veldtype en klik op de pagina. Slepen = verplaatsen, hoekje = groter/kleiner.'}</p>
      </div>
      <div class="kaart ${S.geselecteerd ? '' : 'verborgen'}" id="selKaart"></div>
      <div class="kaart">
        <div class="hulp" id="opslag" aria-live="polite">${esc(S.opslagStatus)}</div>
        ${foutHtml()}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button type="button" class="knop knop-licht" id="terugStap">← Gegevens</button>
          <button type="button" class="knop knop-goud" id="naarVersturen">Verder →</button>
        </div>
      </div>
    </aside>
    <section class="pdf-kolom"><div class="pdf-pagina-lijst ${S.actiefType ? 'plaats-modus' : ''}" id="pdf"><div class="kaart">PDF laden…</div></div></section>
  </div>`;

  main.querySelectorAll('[data-ontv]').forEach((b) => { b.onclick = () => { S.actiefOntv = b.dataset.ontv; herteken2(); }; });
  main.querySelectorAll('[data-type]').forEach((b) => { b.onclick = () => { S.actiefType = S.actiefType === b.dataset.type ? null : b.dataset.type; herteken2(); }; });
  $('#terugStap').onclick = async () => { await slaVeldenOp(); S.stap = 1; render(); };
  $('#naarVersturen').onclick = async () => { if (await slaVeldenOp()) { S.stap = 3; render(); } };
  renderSelectie();
  laadPdf();
}

// Alleen het palet opnieuw (de PDF blijft staan).
function herteken2() {
  const pdfEl = $('#pdf');
  const bewaard = pdfEl;
  const scroll = window.scrollY;
  renderStap2Palet();
  if (bewaard) bewaard.classList.toggle('plaats-modus', !!S.actiefType);
  window.scrollTo(0, scroll);
  tekenVelden();
}
function renderStap2Palet() {
  const palet = $('.palet');
  if (!palet) return;
  const ontv = S.env.ontvangers;
  palet.querySelector('.kaart').innerHTML = `
    <h2>1. Voor wie?</h2>
    ${ontv.map((o, i) => `<button type="button" class="wie-knop ${S.actiefOntv === o.id ? 'actief' : ''}" data-ontv="${esc(o.id)}"><span class="kleur" style="width:12px;height:12px;border-radius:50%;background:${KLEUREN[i % KLEUREN.length]}"></span><span>${i + 1}. ${esc(o.naam)}<br><small class="hulp">${S.velden.filter((v) => v.ontvanger_id === o.id).length} veld(en)</small></span></button>`).join('')}
    <h2 style="margin-top:14px">2. Welk veld?</h2>
    <div class="types">${TYPES.map(([t, l]) => `<button type="button" class="type ${S.actiefType === t ? 'actief' : ''}" data-type="${t}" aria-pressed="${S.actiefType === t}">${l}</button>`).join('')}</div>
    <p class="hulp" style="margin:10px 0 0;font-size:12.5px">${S.actiefType ? `Klik op de pagina om een <b>${TYPE_LABEL[S.actiefType].toLowerCase()}</b> te plaatsen.` : 'Kies een veldtype en klik op de pagina. Slepen = verplaatsen, hoekje = groter/kleiner.'}</p>`;
  palet.querySelectorAll('[data-ontv]').forEach((b) => { b.onclick = () => { S.actiefOntv = b.dataset.ontv; herteken2(); }; });
  palet.querySelectorAll('[data-type]').forEach((b) => { b.onclick = () => { S.actiefType = S.actiefType === b.dataset.type ? null : b.dataset.type; herteken2(); }; });
  renderSelectie();
}

function renderSelectie() {
  const k = $('#selKaart'); if (!k) return;
  const v = S.velden.find((x) => x._k === S.geselecteerd);
  k.classList.toggle('verborgen', !v);
  if (!v) { k.innerHTML = ''; return; }
  const kanOptioneel = v.type === 'tekst' || v.type === 'checkbox' || v.type === 'paraaf';
  k.innerHTML = `<h2>Geselecteerd: ${esc(TYPE_LABEL[v.type])}</h2>
    <div class="veld"><label for="selOntv">Voor</label><select id="selOntv">${S.env.ontvangers.map((o) => `<option value="${esc(o.id)}" ${o.id === v.ontvanger_id ? 'selected' : ''}>${esc(o.naam)}</option>`).join('')}</select></div>
    ${kanOptioneel ? `<label class="akkoord" style="margin-bottom:10px"><input type="checkbox" id="selVerplicht" ${v.verplicht ? 'checked' : ''}> Verplicht</label>` : '<p class="hulp" style="font-size:12.5px">Dit veld is altijd verplicht.</p>'}
    <button type="button" class="knop knop-licht knop-klein" id="selWeg">Veld verwijderen</button>`;
  $('#selOntv').onchange = (e) => wijzigVeld(v._k, { ontvanger_id: e.target.value });
  const vp = $('#selVerplicht'); if (vp) vp.onchange = (e) => wijzigVeld(v._k, { verplicht: e.target.checked });
  $('#selWeg').onclick = () => verwijderVeld(v._k);
}

let _k = 0;
const sleutel = () => 'k' + (++_k);

async function laadPdf() {
  try {
    const d = await api('/api/esign?actie=detail&id=' + encodeURIComponent(S.id));
    S.env = d.envelope;
    S.velden = S.velden.length ? S.velden : (d.envelope.velden || []).map((v) => ({ ...v }));
    S.velden.forEach((v) => { if (!v._k) v._k = sleutel(); });
    S.pdf = await toonPdf($('#pdf'), d.document_url, { opPagina: (p) => { koppelPagina(p); tekenVelden(p.nummer); } });
    renderStap2Palet();
  } catch (e) {
    console.error('[editor] pdf:', e);
    $('#pdf').innerHTML = `<div class="melding fout">Het document kon niet geladen worden: ${esc(e.message)}</div>`;
  }
}

function paginaVan(nr) { return S.pdf?.paginas.find((p) => p.nummer === nr); }

function koppelPagina(p) {
  if (p.laag._gekoppeld) return;
  p.laag._gekoppeld = true;
  p.laag.addEventListener('pointerdown', (e) => {
    if (e.target !== p.laag) return;
    if (!S.actiefType) { S.geselecteerd = null; renderSelectie(); tekenVelden(); return; }
    if (!S.actiefOntv) { zetOpslag('Kies eerst voor wie het veld is.'); return; }
    const r = p.laag.getBoundingClientRect();
    const info = S.env.documenten[0].paginas[p.nummer - 1];
    const maat = STANDAARD_MAAT_PT[S.actiefType];
    const w = (maat.breedte / info.breedte) * p.breedte; const h = (maat.hoogte / info.hoogte) * p.hoogte;
    const f = pxNaarFractie({ left: e.clientX - r.left - w / 2, top: e.clientY - r.top - h / 2, width: w, height: h }, p.breedte, p.hoogte);
    const v = { _k: sleutel(), document_id: S.env.documenten[0].id, ontvanger_id: S.actiefOntv, type: S.actiefType, pagina: p.nummer, verplicht: true, ...f };
    S.velden.push(v); S.geselecteerd = v._k; S.actiefType = null;
    herteken2(); planOpslaan();
  });
}

function tekenVelden(alleenPagina) {
  if (!S.pdf) return;
  for (const p of S.pdf.paginas) {
    if (alleenPagina && p.nummer !== alleenPagina) continue;
    p.laag.innerHTML = '';
    for (const v of S.velden.filter((x) => x.pagina === p.nummer)) p.laag.appendChild(veldElement(v, p));
  }
}

function veldElement(v, p) {
  const r = fractieNaarPx(v, p.breedte, p.hoogte);
  const kleur = kleurVan(v.ontvanger_id);
  const naam = S.env.ontvangers.find((o) => o.id === v.ontvanger_id)?.naam || '';
  const el = document.createElement('div');
  el.className = 'vk editor' + (S.geselecteerd === v._k ? ' geselecteerd' : '');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `${TYPE_LABEL[v.type]} voor ${naam}`);
  Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderColor: kleur, color: kleur, background: kleur + '1f' });
  el.innerHTML = `<span class="lbl">${v.type === 'checkbox' ? '☐' : esc(TYPE_LABEL[v.type])}${v.verplicht || v.type === 'checkbox' ? '' : ' (opt.)'}</span>
    <button type="button" class="weg" style="background:${kleur}" aria-label="Verwijderen">×</button><span class="greep" style="background:${kleur}"></span>`;
  el.querySelector('.weg').addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  el.querySelector('.weg').addEventListener('click', (e) => { e.stopPropagation(); verwijderVeld(v._k); });

  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('weg')) return;
    e.preventDefault(); e.stopPropagation();
    const groot = e.target.classList.contains('greep');
    start = { x: e.clientX, y: e.clientY, r: fractieNaarPx(v, p.breedte, p.hoogte), groot, bewogen: false };
    el.setPointerCapture(e.pointerId);
    if (S.geselecteerd !== v._k) { S.geselecteerd = v._k; document.querySelectorAll('.vk.geselecteerd').forEach((x) => x.classList.remove('geselecteerd')); el.classList.add('geselecteerd'); renderSelectie(); }
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x; const dy = e.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) start.bewogen = true;
    const n = start.groot
      ? { left: start.r.left, top: start.r.top, width: Math.max(12, start.r.width + dx), height: Math.max(10, start.r.height + dy) }
      : { left: start.r.left + dx, top: start.r.top + dy, width: start.r.width, height: start.r.height };
    const f = pxNaarFractie(n, p.breedte, p.hoogte);
    const px = fractieNaarPx(f, p.breedte, p.hoogte);
    Object.assign(el.style, { left: px.left + 'px', top: px.top + 'px', width: px.width + 'px', height: px.height + 'px' });
    start.f = f;
  });
  const los = () => { if (start?.bewogen && start.f) wijzigVeld(v._k, start.f, { stil: true }); start = null; };
  el.addEventListener('pointerup', los); el.addEventListener('pointercancel', los);
  el.addEventListener('keydown', (e) => {
    const stap = e.shiftKey ? 0.01 : 0.002;
    const d = { ArrowLeft: [-stap, 0], ArrowRight: [stap, 0], ArrowUp: [0, -stap], ArrowDown: [0, stap] }[e.key];
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); verwijderVeld(v._k); return; }
    if (!d) return;
    e.preventDefault();
    wijzigVeld(v._k, { x: Math.min(1 - v.breedte, Math.max(0, v.x + d[0])), y: Math.min(1 - v.hoogte, Math.max(0, v.y + d[1])) });
    S.geselecteerd = v._k;
    setTimeout(() => document.querySelector(`.vk.geselecteerd`)?.focus(), 0);
  });
  return el;
}

function wijzigVeld(k, patch, { stil = false } = {}) {
  const v = S.velden.find((x) => x._k === k); if (!v) return;
  Object.assign(v, patch);
  if (!stil) { tekenVelden(v.pagina); renderSelectie(); }
  if (patch.ontvanger_id) renderStap2Palet();
  planOpslaan();
}
function verwijderVeld(k) {
  const i = S.velden.findIndex((x) => x._k === k); if (i < 0) return;
  const nr = S.velden[i].pagina;
  S.velden.splice(i, 1); if (S.geselecteerd === k) S.geselecteerd = null;
  tekenVelden(nr); renderStap2Palet(); planOpslaan();
}

function zetOpslag(t) { S.opslagStatus = t; const el = $('#opslag'); if (el) el.textContent = t; }
function planOpslaan() { zetOpslag('Wijzigingen nog niet opgeslagen…'); clearTimeout(S.opslaanTimer); S.opslaanTimer = setTimeout(() => { slaVeldenOp(); }, 1200); }
async function slaVeldenOp() {
  clearTimeout(S.opslaanTimer);
  zetOpslag('Opslaan…');
  try {
    const j = await post({
      actie: 'velden_opslaan', id: S.id,
      velden: S.velden.map(({ document_id, ontvanger_id, type, pagina, x, y, breedte, hoogte, verplicht }) => ({ document_id, ontvanger_id, type, pagina, x, y, breedte, hoogte, verplicht })),
    });
    S.env = { ...S.env, ontvangers: j.envelope.ontvangers, documenten: j.envelope.documenten };
    zetOpslag('Alles opgeslagen ✓'); S.fout = null;
    return true;
  } catch (e) {
    zetOpslag('Opslaan mislukt: ' + e.message);
    return false;
  }
}

// ── Stap 3: versturen ───────────────────────────────────────────────────────
function renderStap3(main) {
  const e = S.env;
  const problemen = [];
  for (const o of e.ontvangers) if (!S.velden.some((v) => v.ontvanger_id === o.id && v.type === 'handtekening')) problemen.push(`${o.naam} heeft nog geen handtekeningveld.`);
  main.innerHTML = `${stappenHtml()}
  <div class="kaart">
    <h1>Controleren en versturen</h1>
    ${foutHtml()}
    ${problemen.length ? `<div class="melding fout">${problemen.map(esc).join('<br>')}</div>` : '<div class="melding ok">Alles klaar om te versturen.</div>'}
    <div class="veld"><span class="label">Titel</span><div>${esc(e.titel)}</div></div>
    <div class="veld"><span class="label">Document</span><div>📄 ${esc(e.documenten[0]?.naam || '-')} · ${e.documenten[0]?.paginas.length || 0} pagina('s)</div><div class="hulp" style="word-break:break-all">SHA-256: ${esc(e.documenten[0]?.sha256 || '-')}</div></div>
    <div class="veld"><span class="label">Volgorde</span><div>${e.volgorde === 'parallel' ? 'Tegelijk — iedereen krijgt meteen een mail' : 'Een voor een — in deze volgorde'}</div></div>
    <div class="ontv-lijst">${e.ontvangers.map((o, i) => `<div class="ontv"><span class="nr">${i + 1}</span><span class="kleur" style="background:${KLEUREN[i % KLEUREN.length]}"></span><span class="wie">${esc(o.naam)}<small>${esc(o.email)} · ${S.velden.filter((v) => v.ontvanger_id === o.id).length} veld(en)</small></span></div>`).join('')}</div>
    <p class="hulp">Elke ondertekenaar krijgt een persoonlijke link die 14 dagen geldig is. Na het versturen kun je de envelope niet meer wijzigen, wel intrekken.</p>
    <div style="display:flex;justify-content:space-between;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button type="button" class="knop knop-licht" id="terug2">← Velden</button>
      <button type="button" class="knop knop-goud" id="verstuur" ${problemen.length || S.bezig ? 'disabled' : ''}>${S.bezig ? 'Versturen…' : 'Versturen'}</button>
    </div>
  </div>`;
  $('#terug2').onclick = () => { S.stap = 2; render(); };
  $('#verstuur').onclick = async () => {
    if (!confirm(`"${e.titel}" nu versturen naar ${e.ontvangers.length} ondertekenaar(s)?`)) return;
    S.bezig = true; S.fout = null; render();
    try {
      const j = await post({ actie: 'versturen', id: S.id });
      const mislukt = (j.uitnodigingen || []).filter((u) => !u.mail_ok);
      main.innerHTML = `<div class="kaart status-groot"><div class="ico">✉️</div><h1>Verstuurd</h1>
        <p class="sub">${e.volgorde === 'parallel' ? 'Alle ondertekenaars hebben een mail gekregen.' : 'De eerste ondertekenaar heeft een mail gekregen.'}</p>
        ${mislukt.length ? `<div class="melding fout">${mislukt.length} mail(s) konden niet verstuurd worden. Gebruik "Opnieuw versturen" in het overzicht.</div>` : ''}
        <p><a class="knop knop-navy" href="/modules/klanten-v2/#esign">Naar het overzicht</a></p></div>`;
    } catch (err) {
      S.bezig = false; S.fout = err.message; render();
    }
  };
}

// ── Start ───────────────────────────────────────────────────────────────────
async function start() {
  await window._authSharedReady;
  const profiel = await window.AuthShared.requireAuth();
  if (!profiel) return;
  try {
    S.teamleden = (await api('/api/esign?actie=teamleden')).teamleden || [];
  } catch (e) {
    $('#main').innerHTML = `<div class="kaart status-groot"><h1>Geen toegang</h1><p class="sub">${esc(e.status === 403 ? 'Je hebt het recht esign.send niet.' : e.message)}</p></div>`;
    return;
  }
  if (S.id) {
    try {
      const d = await api('/api/esign?actie=detail&id=' + encodeURIComponent(S.id));
      S.env = d.envelope;
      S.gekozenOntv = (d.envelope.ontvangers || []).map((o) => o.profile_id).filter(Boolean);
      if (d.envelope.entiteit_type && d.envelope.entiteit_id) { S.koppeling = { type: d.envelope.entiteit_type, id: d.envelope.entiteit_id }; S.koppelNaam = 'Gekoppelde ' + d.envelope.entiteit_type; }
      _invoer = { titel: S.env.titel, bericht: S.env.bericht || '', volgorde: S.env.volgorde };
    } catch (e) {
      $('#main').innerHTML = `<div class="kaart status-groot"><h1>Niet gevonden</h1><p class="sub">${esc(e.message)}</p></div>`;
      return;
    }
  }
  render();
}

window.addEventListener('beforeunload', (e) => { if (S.opslagStatus.startsWith('Wijzigingen nog niet')) { e.preventDefault(); e.returnValue = ''; } });
start();
