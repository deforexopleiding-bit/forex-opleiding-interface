// modules/esign/teken.js — tekenpagina (/teken#t=<token>)
//
// 1. token uit de #-hash → POST /api/esign-teken {actie:'open'}
// 2. PDF tonen (pdf.js) met de eigen velden erop
// 3. handtekening/paraaf tekenen of typen; tekst/vinkjes invullen;
//    datum en naam vult de server zelf in
// 4. akkoord-vinkje → POST {actie:'teken'} → klaar-scherm

import { toonPdf } from './pdf-weergave.js';
import { fractieNaarPx } from './esign-coords.js';
import { vraagHandtekening } from './handtekening-pad.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('t') || '';

const S = { data: null, waarden: {}, beelden: {}, bezig: false, pdf: null };

async function api(body) {
  const r = await fetch('/api/esign-teken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...body }),
    referrerPolicy: 'no-referrer', cache: 'no-store',
  });
  let j = {}; try { j = await r.json(); } catch (_) { /* */ }
  if (!r.ok) throw Object.assign(new Error(j.error || 'Er ging iets mis.'), { status: r.status, body: j });
  return j;
}

function statusScherm(ico, titel, tekst) {
  $('#balk').classList.add('verborgen');
  $('#main').innerHTML = `<div class="kaart status-groot"><div class="ico" aria-hidden="true">${ico}</div><h1>${esc(titel)}</h1><p class="sub">${esc(tekst)}</p></div>`;
}

function kopHtml(d) {
  const chips = d.ondertekenaars.map((o) => `<span class="chip${o.status === 'getekend' ? ' ok' : ''}${o.ik ? ' ik' : ''}">${o.status === 'getekend' ? '✓' : '○'} ${esc(o.naam)}${o.ik ? ' (jij)' : ''}</span>`).join('');
  return `<div class="kaart">
    <h1>${esc(d.envelope.titel)}</h1>
    <p class="sub">Voor ${esc(d.ontvanger.naam)} · ${esc(d.ontvanger.email)}</p>
    ${d.envelope.bericht ? `<div class="melding info">${esc(d.envelope.bericht)}</div>` : ''}
    <div class="ondertekenaars" aria-label="Ondertekenaars">${chips}</div>
    <p class="sub" style="margin-top:12px;font-size:13.5px">Klik op de gele vakken om ze in te vullen. Datum en naam worden automatisch ingevuld.</p>
  </div>`;
}

const LABEL = { handtekening: 'Handtekening', paraaf: 'Paraaf', datum: 'Datum', naam: 'Naam', tekst: 'Tekst', checkbox: '' };
function vandaag() { return new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date()).replace(/\//g, '-'); }

function isIngevuld(v) {
  if (v.type === 'handtekening' || v.type === 'paraaf') return !!S.beelden[v.type];
  if (v.type === 'datum' || v.type === 'naam') return true;
  if (v.type === 'checkbox') return S.waarden[v.id] === true;
  return !!String(S.waarden[v.id] || '').trim();
}
function openVerplicht() { return S.data.velden.filter((v) => (v.verplicht || v.type === 'handtekening' || v.type === 'paraaf') && !isIngevuld(v)); }

function werkBalkBij() {
  const totaal = S.data.velden.filter((v) => v.verplicht || v.type === 'handtekening' || v.type === 'paraaf').length;
  const open = openVerplicht().length;
  $('#voortgang').textContent = open ? `Nog ${open} van ${totaal} verplichte velden in te vullen.` : 'Alles ingevuld. Vink het akkoord aan en verstuur.';
  $('#verstuur').disabled = S.bezig || open > 0 || !$('#akkoord').checked;
  $('#volgende').classList.toggle('verborgen', open === 0);
}

function vulVeld(el, v) {
  el.classList.toggle('klaar', isIngevuld(v));
  if (v.type === 'handtekening' || v.type === 'paraaf') {
    el.innerHTML = S.beelden[v.type] ? `<img alt="${LABEL[v.type]}" src="${S.beelden[v.type].dataUrl}">` : `<span class="lbl">✍ ${LABEL[v.type]}</span>`;
  }
}

async function kiesBeeld(soort) {
  const naam = S.data.ontvanger.naam || '';
  const standaard = soort === 'paraaf' ? naam.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 4) : naam;
  const r = await vraagHandtekening({ titel: soort === 'paraaf' ? 'Je paraaf' : 'Je handtekening', standaardTekst: standaard, soort });
  if (!r) return;
  if (r.dataUrl.length > 380000) { alert('Deze handtekening is te groot. Probeer het opnieuw met een eenvoudigere handtekening.'); return; }
  S.beelden[soort] = r;
  document.querySelectorAll(`.vk[data-type="${soort}"]`).forEach((el) => vulVeld(el, S.data.velden.find((x) => x.id === el.dataset.id)));
  werkBalkBij();
}

function plaatsVelden(p) {
  p.laag.innerHTML = '';
  for (const v of S.data.velden.filter((x) => x.pagina === p.nummer)) {
    const r = fractieNaarPx(v, p.breedte, p.hoogte);
    const el = document.createElement('div');
    el.className = 'vk teken';
    el.dataset.id = v.id; el.dataset.type = v.type;
    Object.assign(el.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    if (v.type === 'handtekening' || v.type === 'paraaf') {
      el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', `${LABEL[v.type]} plaatsen`);
      el.addEventListener('click', () => kiesBeeld(v.type));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); kiesBeeld(v.type); } });
      vulVeld(el, v);
    } else if (v.type === 'datum' || v.type === 'naam') {
      el.classList.add('statisch', 'klaar');
      el.innerHTML = `<span class="lbl">${esc(v.type === 'datum' ? vandaag() : S.data.ontvanger.naam)}</span>`;
      el.title = 'Wordt automatisch ingevuld';
    } else if (v.type === 'tekst') {
      el.innerHTML = '<input type="text" maxlength="500">';
      const inp = el.querySelector('input');
      inp.setAttribute('aria-label', v.verplicht ? 'Tekstveld (verplicht)' : 'Tekstveld');
      inp.placeholder = v.verplicht ? 'Verplicht' : 'Optioneel';
      inp.value = S.waarden[v.id] || '';
      inp.addEventListener('input', () => { S.waarden[v.id] = inp.value; el.classList.toggle('klaar', isIngevuld(v)); werkBalkBij(); });
      el.classList.toggle('klaar', isIngevuld(v));
    } else if (v.type === 'checkbox') {
      el.innerHTML = '<input type="checkbox">';
      const cb = el.querySelector('input');
      cb.setAttribute('aria-label', v.verplicht ? 'Aanvinken (verplicht)' : 'Aanvinken');
      cb.checked = S.waarden[v.id] === true;
      cb.addEventListener('change', () => { S.waarden[v.id] = cb.checked; el.classList.toggle('klaar', isIngevuld(v)); werkBalkBij(); });
      el.classList.toggle('klaar', isIngevuld(v));
    }
    p.laag.appendChild(el);
  }
}

function naarVolgende() {
  const v = openVerplicht()[0];
  if (!v) return;
  const el = document.querySelector(`.vk[data-id="${v.id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('vereist-leeg'); void el.offsetWidth; el.classList.add('vereist-leeg');
  const focusDoel = el.querySelector('input') || el;
  setTimeout(() => focusDoel.focus({ preventScroll: true }), 350);
}

async function verstuur() {
  if (S.bezig) return;
  if (openVerplicht().length) { naarVolgende(); return; }
  S.bezig = true; werkBalkBij();
  $('#verstuur').textContent = 'Bezig met ondertekenen…';
  try {
    const waarden = {};
    for (const v of S.data.velden) if (v.type === 'tekst' || v.type === 'checkbox') waarden[v.id] = S.waarden[v.id] ?? (v.type === 'checkbox' ? false : '');
    const r = await api({
      actie: 'teken', akkoord: $('#akkoord').checked, waarden,
      handtekening: S.beelden.handtekening || null, paraaf: S.beelden.paraaf || null,
    });
    statusScherm('✅', 'Bedankt, je hebt ondertekend', r.voltooid
      ? 'Iedereen heeft getekend. Je ontvangt het getekende document per e-mail.'
      : 'Zodra alle ondertekenaars getekend hebben, ontvang je het getekende document per e-mail.');
  } catch (e) {
    S.bezig = false;
    $('#verstuur').textContent = 'Ondertekenen en versturen';
    if (e.body?.code === 'AL_GETEKEND') { statusScherm('✅', 'Al ondertekend', 'Je hebt dit document al ondertekend.'); return; }
    if (e.body?.veld_id) {
      const el = document.querySelector(`.vk[data-id="${e.body.veld_id}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('vereist-leeg'); }
    }
    alert(e.message);
    werkBalkBij();
  }
}

async function start() {
  if (!token) { statusScherm('🔗', 'Link onvolledig', 'Open de link uit de e-mail opnieuw; hij lijkt niet volledig te zijn.'); return; }
  let d;
  try { d = await api({ actie: 'open' }); }
  catch (e) {
    if (e.status === 410) statusScherm('🚫', 'Ingetrokken', e.message);
    else if (e.status === 429) statusScherm('⏱️', 'Even geduld', e.message);
    else statusScherm('🔒', 'Link werkt niet', e.message);
    return;
  }
  S.data = d;
  if (d.reden === 'al_getekend') { statusScherm('✅', 'Al ondertekend', 'Je hebt dit document al ondertekend. Je ontvangt het getekende exemplaar per e-mail zodra iedereen getekend heeft.'); return; }
  if (d.reden === 'voltooid') { statusScherm('✅', 'Voltooid', 'Dit document is door iedereen ondertekend.'); return; }
  if (d.reden === 'wacht_op_anderen' || !d.mag_tekenen || !d.document) {
    statusScherm('⏳', 'Nog niet aan de beurt', 'Iemand anders moet eerst tekenen. Je krijgt een nieuwe mail zodra jij aan de beurt bent.');
    return;
  }
  $('#main').innerHTML = kopHtml(d) + '<div class="kaart" style="padding:16px"><div class="pdf-pagina-lijst" id="pdf"></div></div>';
  $('#balk').classList.remove('verborgen');
  $('#akkoord').addEventListener('change', werkBalkBij);
  $('#verstuur').addEventListener('click', verstuur);
  $('#volgende').addEventListener('click', naarVolgende);
  werkBalkBij();
  try {
    S.pdf = await toonPdf($('#pdf'), d.document.url, { opPagina: plaatsVelden });
  } catch (e) {
    console.error('[teken] pdf:', e);
    statusScherm('⚠️', 'Document niet te tonen', 'Het document kon niet geladen worden. Vernieuw de pagina; lukt het niet, vraag de afzender om een nieuwe link.');
  }
}

start();
