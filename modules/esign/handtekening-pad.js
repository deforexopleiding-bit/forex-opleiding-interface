// modules/esign/handtekening-pad.js
//
// Handtekening of paraaf maken: TEKENEN op een canvas (muis, pen, vinger) of
// TYPEN (gerenderd in een handschriftlettertype). Levert een bijgesneden PNG
// als data-URL + de methode ('getekend' | 'getypt'). Geen afhankelijkheden.

const SCRIPT_FONT = '"Dancing Script", "Segoe Script", "Brush Script MT", cursive';
const INKT = '#0f1c40';

function bijsnijden(canvas, marge = 8) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - marge); y0 = Math.max(0, y0 - marge);
  x1 = Math.min(w - 1, x1 + marge); y1 = Math.min(h - 1, y1 + marge);
  const uit = document.createElement('canvas');
  uit.width = x1 - x0 + 1; uit.height = y1 - y0 + 1;
  uit.getContext('2d').drawImage(canvas, x0, y0, uit.width, uit.height, 0, 0, uit.width, uit.height);
  return uit.toDataURL('image/png');
}

/** Getypte tekst → PNG in het handschriftlettertype. */
export async function typNaarPng(tekst, { hoogte = 120 } = {}) {
  const t = String(tekst || '').trim().slice(0, 60);
  if (!t) return null;
  try { if (document.fonts && document.fonts.load) await document.fonts.load(`64px ${SCRIPT_FONT}`); } catch (_) { /* valt terug */ }
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const size = Math.round(hoogte * 0.6);
  ctx.font = `${size}px ${SCRIPT_FONT}`;
  c.width = Math.min(1600, Math.ceil(ctx.measureText(t).width + size));
  c.height = hoogte;
  ctx.font = `${size}px ${SCRIPT_FONT}`;
  ctx.fillStyle = INKT; ctx.textBaseline = 'middle';
  ctx.fillText(t, size / 2, hoogte / 2);
  return bijsnijden(c);
}

/**
 * Opent een venster om te tekenen of te typen.
 * @param {{ titel:string, standaardTekst:string, soort:'handtekening'|'paraaf' }} opts
 * @returns {Promise<{ dataUrl:string, methode:'getekend'|'getypt' }|null>} null = geannuleerd
 */
export function vraagHandtekening({ titel, standaardTekst = '', soort = 'handtekening' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'hp-scrim';
    wrap.innerHTML = `
      <div class="hp-box" role="dialog" aria-modal="true" aria-labelledby="hp-titel">
        <div class="hp-kop"><h2 id="hp-titel"></h2><button type="button" class="hp-x" aria-label="Sluiten">×</button></div>
        <div class="hp-tabs" role="tablist">
          <button type="button" role="tab" class="hp-tab actief" data-m="getekend" aria-selected="true">Tekenen</button>
          <button type="button" role="tab" class="hp-tab" data-m="getypt" aria-selected="false">Typen</button>
        </div>
        <div class="hp-paneel" data-p="getekend">
          <canvas class="hp-canvas" aria-label="Teken hier je ${soort}"></canvas>
          <div class="hp-hint">Teken met je muis, pen of vinger. <button type="button" class="hp-wis">Wissen</button></div>
        </div>
        <div class="hp-paneel" data-p="getypt" hidden>
          <input class="hp-input" type="text" maxlength="60" autocomplete="off" aria-label="Typ je ${soort}">
          <div class="hp-voorbeeld" aria-hidden="true"></div>
        </div>
        <div class="hp-voet">
          <button type="button" class="knop knop-licht hp-annuleer">Annuleren</button>
          <button type="button" class="knop knop-goud hp-ok">Gebruiken</button>
        </div>
      </div>`;
    wrap.querySelector('#hp-titel').textContent = titel;
    document.body.appendChild(wrap);
    const vorigeFocus = document.activeElement;

    let methode = 'getekend';
    const canvas = wrap.querySelector('.hp-canvas');
    const input = wrap.querySelector('.hp-input');
    const voorbeeld = wrap.querySelector('.hp-voorbeeld');
    input.value = standaardTekst;
    const toonVoorbeeld = () => { voorbeeld.textContent = input.value || ' '; voorbeeld.style.fontFamily = SCRIPT_FONT; };
    toonVoorbeeld();
    input.addEventListener('input', toonVoorbeeld);

    // Canvas op ware pixelgrootte.
    const ctx = canvas.getContext('2d');
    let leeg = true;
    function maat() {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = soort === 'paraaf' ? 2.6 : 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = INKT;
      leeg = true;
    }
    requestAnimationFrame(maat);
    let tekent = false; let vorig = null;
    const punt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => { tekent = true; vorig = punt(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!tekent) return;
      const p = punt(e);
      ctx.beginPath(); ctx.moveTo(vorig.x, vorig.y);
      ctx.quadraticCurveTo(vorig.x, vorig.y, (vorig.x + p.x) / 2, (vorig.y + p.y) / 2);
      ctx.lineTo(p.x, p.y); ctx.stroke();
      vorig = p; leeg = false; e.preventDefault();
    });
    const stop = () => { tekent = false; vorig = null; };
    canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
    wrap.querySelector('.hp-wis').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); leeg = true; });

    wrap.querySelectorAll('.hp-tab').forEach((b) => b.addEventListener('click', () => {
      methode = b.dataset.m;
      wrap.querySelectorAll('.hp-tab').forEach((x) => { const a = x === b; x.classList.toggle('actief', a); x.setAttribute('aria-selected', String(a)); });
      wrap.querySelectorAll('.hp-paneel').forEach((p) => { p.hidden = p.dataset.p !== methode; });
      if (methode === 'getypt') input.focus(); else requestAnimationFrame(maat);
    }));

    function sluit(waarde) {
      document.removeEventListener('keydown', toets);
      wrap.remove();
      try { vorigeFocus && vorigeFocus.focus(); } catch (_) { /* */ }
      resolve(waarde);
    }
    function toets(e) { if (e.key === 'Escape') sluit(null); }
    document.addEventListener('keydown', toets);
    wrap.querySelector('.hp-x').addEventListener('click', () => sluit(null));
    wrap.querySelector('.hp-annuleer').addEventListener('click', () => sluit(null));
    wrap.querySelector('.hp-ok').addEventListener('click', async () => {
      let dataUrl = null;
      if (methode === 'getekend') {
        if (leeg) { canvas.classList.add('hp-fout'); setTimeout(() => canvas.classList.remove('hp-fout'), 900); return; }
        dataUrl = bijsnijden(canvas);
      } else {
        dataUrl = await typNaarPng(input.value);
        if (!dataUrl) { input.focus(); return; }
      }
      if (!dataUrl) return;
      sluit({ dataUrl, methode });
    });
    wrap.querySelector('.hp-tab.actief').focus();
  });
}
