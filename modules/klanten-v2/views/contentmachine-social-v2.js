// modules/klanten-v2/views/contentmachine-social-v2.js
//
// Contentmachine — social-beelden (fase 3), getekend op een <canvas> in de browser:
//   stories 1080×1920 (3-5) · carrousel 1080×1350 (5-7) · vierkant 1080×1080 ·
//   LinkedIn 1200×1200 (vierkant of slide 1) · OG-beeld 1200×630 voor de pagina.
// Huisstijl van training.deforexopleiding.nl: navy-verloop met raster, Inter 900-koppen,
// goud accent, foto's in een kader met afgeronde hoeken, chart-illustratie als er geen
// foto is. Drie stijlen (0 Klassiek · 1 Foto groot · 2 Accent) zodat het niet elke week
// identiek oogt; de stijl volgt uit de drop (te wisselen met "Andere stijl").
//
// Waarom canvas en geen DOM→PNG-bibliotheek: voorspelbare pixels, geen externe code
// (supply-chain), en de fonts komen zelf-gehost uit /img/contentmachine/fonts/ (OFL).
// Beelden uit Storage worden met crossOrigin=anonymous geladen (publieke bucket stuurt CORS).
//
// Uitvoer: PNG per stuk (download), alles als ZIP (eigen kleine zip-schrijver, STORE —
// PNG is al gecomprimeerd) en opgeslagen in Storage drops/<slug>/social/<naam>.png
// (signed upload via /api/contentmachine/assets, lijst in output.social via drops 'social').
(function () {
  'use strict';
  window.DFO = window.DFO || {};

  const KLEUR = { navy950: '#0B1E2A', navy900: '#112B3B', navy800: '#17364A', navy700: '#1F455F', navy600: '#2A5876', goud: '#D0A050', goudLicht: '#E2B866', wit: '#FFFFFF', tekst: '#D9E3E8', zacht: '#8FA7B5', bull: '#3FC79A', bear: '#E5675C' };
  const FONT = 'DFOInter';
  const HOST = 'training.deforexopleiding.nl';
  const STIJLEN = ['Klassiek', 'Foto groot', 'Accent'];

  // ── Fonts ─────────────────────────────────────────────────────────────────
  let fontsKlaar = null;
  function laadFonts() {
    if (fontsKlaar) return fontsKlaar;
    const basis = (window.__cmFontBasis || '/img/contentmachine/fonts/');
    const gewichten = [500, 700, 800, 900];
    fontsKlaar = Promise.all(gewichten.map((w) => {
      if (typeof FontFace === 'undefined') return null;
      const f = new FontFace(FONT, `url(${basis}inter-latin-${w}-normal.woff2) format('woff2')`, { weight: String(w) });
      return f.load().then((x) => { document.fonts.add(x); return x; }).catch((e) => { console.error('[contentmachine-social] font', w, e); return null; });
    }));
    return fontsKlaar;
  }

  // ── Beelden ───────────────────────────────────────────────────────────────
  const beeldCache = new Map();
  function laadBeeld(url) {
    if (!url) return Promise.resolve(null);
    if (beeldCache.has(url)) return beeldCache.get(url);
    const p = new Promise((ok) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => ok(img);
      img.onerror = () => { console.error('[contentmachine-social] beeld laden mislukt:', url); ok(null); };
      img.src = url;
    });
    beeldCache.set(url, p);
    return p;
  }

  // ── Tekenhulpen ───────────────────────────────────────────────────────────
  const font = (w, px) => `${w} ${Math.round(px)}px ${FONT}, Inter, Arial, sans-serif`;
  function spatie(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }

  function rondRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function achtergrond(ctx, w, h, stijl) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, KLEUR.navy900); g.addColorStop(0.7, KLEUR.navy950); g.addColorStop(1, KLEUR.navy950);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const glow = (cx, cy, r, kleur) => {
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, kleur); rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
    };
    glow(w * (stijl === 2 ? 0.1 : 0.9), -h * 0.05, Math.max(w, h) * 0.65, 'rgba(208,160,80,0.18)');
    glow(-w * 0.1, h * 0.35, Math.max(w, h) * 0.6, 'rgba(42,88,118,0.5)');
    // raster, uitlopend naar onder
    ctx.save();
    const stap = Math.round(w / 16.875);
    ctx.strokeStyle = 'rgba(217,227,232,0.07)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += stap) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = 0; y <= h; y += stap) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();
    const fade = ctx.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(11,30,42,0)'); fade.addColorStop(0.55, 'rgba(11,30,42,0.55)'); fade.addColorStop(1, 'rgba(11,30,42,0.95)');
    ctx.fillStyle = fade; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  function merk(ctx, x, y, s) {
    ctx.save();
    const b = 54 * s;
    const g = ctx.createLinearGradient(x, y, x + b, y + b);
    g.addColorStop(0, KLEUR.goud); g.addColorStop(1, '#B88941');
    ctx.fillStyle = g; rondRect(ctx, x, y, b, b, 15 * s); ctx.fill();
    ctx.fillStyle = KLEUR.navy950; ctx.font = font(900, 19 * s); ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    spatie(ctx, 0); ctx.fillText('DFO', x + b / 2, y + b / 2 + 1);
    ctx.textAlign = 'left'; ctx.fillStyle = KLEUR.wit; ctx.font = font(800, 20 * s); spatie(ctx, 3.4 * s);
    ctx.fillText('DE FOREX OPLEIDING', x + b + 16 * s, y + b / 2 + 1);
    ctx.restore();
    return y + b;
  }

  /** Woorden met stijl: '**…**' = accent (goud). */
  function delen(tekst) {
    const uit = [];
    String(tekst || '').split(/(\*\*[^*]+\*\*)/).forEach((stuk) => {
      if (!stuk) return;
      const accent = /^\*\*.*\*\*$/.test(stuk);
      const schoon = accent ? stuk.slice(2, -2) : stuk;
      schoon.split(/(\n)/).forEach((r) => {
        if (r === '\n') { uit.push({ breek: true }); return; }
        r.split(/\s+/).filter(Boolean).forEach((woord) => uit.push({ woord, accent }));
      });
    });
    return uit;
  }

  /** Regels opbouwen binnen breedte w. → [[{woord,accent}]] */
  function wrap(ctx, tekst, w) {
    const regels = [[]];
    let breedte = 0;
    const spaceW = ctx.measureText(' ').width;
    for (const d of delen(tekst)) {
      if (d.breek) { regels.push([]); breedte = 0; continue; }
      const ww = ctx.measureText(d.woord).width;
      const huidig = regels[regels.length - 1];
      if (huidig.length && breedte + spaceW + ww > w) { regels.push([d]); breedte = ww; } else { huidig.push(d); breedte += (huidig.length > 1 ? spaceW : 0) + ww; }
    }
    return regels.filter((r, i) => r.length || i < regels.length - 1);
  }

  /**
   * Tekstblok met automatische grootte: grootste px tussen max en min waarbij het
   * binnen maxRegels past. Tekent en geeft de onderkant terug.
   */
  function tekstBlok(ctx, tekst, { x, y, w, max, min, maxRegels, gewicht = 900, kleur = KLEUR.wit, accent = KLEUR.goud, lijn = 1.05, sp = -0.02, uitlijn = 'left', tekenen = true }) {
    if (!tekst) return { onder: y, px: min, regels: [] };
    let px = max; let regels;
    for (; px >= min; px -= 2) {
      ctx.font = font(gewicht, px); spatie(ctx, sp * px);
      regels = wrap(ctx, tekst, w);
      if (regels.length <= maxRegels) break;
    }
    if (px < min) { px = min; ctx.font = font(gewicht, px); spatie(ctx, sp * px); regels = wrap(ctx, tekst, w); }
    if (regels.length > maxRegels) {
      regels = regels.slice(0, maxRegels);
      const laatste = regels[maxRegels - 1];
      if (laatste.length) laatste[laatste.length - 1] = { ...laatste[laatste.length - 1], woord: laatste[laatste.length - 1].woord.replace(/[.,;:!?]*$/, '') + '…' };
    }
    const lh = px * lijn;
    if (tekenen) {
      ctx.textBaseline = 'alphabetic';
      const spaceW = ctx.measureText(' ').width;
      regels.forEach((r, i) => {
        const tot = r.reduce((s, d, j) => s + ctx.measureText(d.woord).width + (j ? spaceW : 0), 0);
        let cx = uitlijn === 'center' ? x + (w - tot) / 2 : x;
        const by = y + px * 0.92 + i * lh;
        r.forEach((d, j) => {
          if (j) cx += spaceW;
          ctx.fillStyle = d.accent ? accent : kleur;
          ctx.fillText(d.woord, cx, by);
          cx += ctx.measureText(d.woord).width;
        });
      });
    }
    return { onder: y + regels.length * lh, px, regels };
  }

  function kicker(ctx, tekst, x, y, s, { lijn = true, uitlijn = 'left', w = 0 } = {}) {
    if (!tekst) return y;
    ctx.save();
    ctx.font = font(800, 24 * s); spatie(ctx, 4 * s); ctx.fillStyle = KLEUR.goud; ctx.textBaseline = 'alphabetic';
    const t = String(tekst).toUpperCase();
    const tw = ctx.measureText(t).width;
    let cx = x;
    if (uitlijn === 'center') cx = x + (w - tw - (lijn ? 52 * s : 0)) / 2;
    if (lijn) { ctx.fillRect(cx, y + 11 * s, 38 * s, 4 * s); cx += 52 * s; }
    ctx.fillText(t, cx, y + 22 * s);
    ctx.restore();
    return y + 30 * s;
  }

  function foto(ctx, img, x, y, w, h, r, { rand = true, fadeOnder = false } = {}) {
    if (!img) return;
    ctx.save();
    rondRect(ctx, x, y, w, h, r); ctx.clip();
    const sch = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * sch; const ih = img.naturalHeight * sch;
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
    if (fadeOnder) {
      const g = ctx.createLinearGradient(0, y + h * 0.45, 0, y + h);
      g.addColorStop(0, 'rgba(11,30,42,0)'); g.addColorStop(1, 'rgba(11,30,42,1)');
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
    if (rand) {
      ctx.save(); rondRect(ctx, x, y, w, h, r);
      ctx.strokeStyle = 'rgba(208,160,80,0.55)'; ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
    }
  }

  /** Gestileerde chart (illustratief), zoals op de trainingspagina. */
  function chartDeco(ctx, x, y, w, h, s, variant = 0) {
    ctx.save();
    rondRect(ctx, x, y, w, h, 28 * s); ctx.fillStyle = 'rgba(10,24,34,0.8)'; ctx.fill();
    ctx.strokeStyle = 'rgba(217,227,232,0.10)'; ctx.lineWidth = 2; ctx.stroke();
    rondRect(ctx, x, y, w, h, 28 * s); ctx.clip();
    ctx.strokeStyle = 'rgba(217,227,232,0.06)'; ctx.lineWidth = 2;
    for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(x, y + (h * i) / 5); ctx.lineTo(x + w, y + (h * i) / 5); ctx.stroke(); }
    const pts = variant % 2
      ? [0.12, 0.2, 0.18, 0.35, 0.3, 0.5, 0.45, 0.62, 0.58, 0.55, 0.7, 0.66, 0.82, 0.78, 0.9, 0.86]
      : [0.2, 0.26, 0.24, 0.33, 0.31, 0.44, 0.42, 0.57, 0.64, 0.6, 0.5, 0.53, 0.39, 0.42, 0.28, 0.17];
    const opwaarts = variant % 2 === 1;
    const zone = opwaarts ? 0.62 : 0.58;
    ctx.fillStyle = 'rgba(208,160,80,0.18)'; ctx.fillRect(x + w * 0.46, y + h * zone, w * 0.54, h * 0.09);
    ctx.fillStyle = KLEUR.goud; ctx.font = font(800, 18 * s); spatie(ctx, 1);
    ctx.fillText('71%', x + w - 70 * s, y + h * zone - 10 * s);
    const P = pts.map((v, i) => [x + (w * i) / (pts.length - 1), y + h * (opwaarts ? 1 - v : v)]);
    const kleur = opwaarts ? KLEUR.bull : KLEUR.bull;
    ctx.beginPath(); P.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
    const g = ctx.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, 'rgba(63,199,154,0.28)'); g.addColorStop(1, 'rgba(63,199,154,0)');
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); P.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = kleur; ctx.lineWidth = 6 * s; ctx.lineJoin = 'round'; ctx.stroke();
    const [ex, ey] = P[P.length - 1];
    ctx.beginPath(); ctx.arc(ex - 4 * s, ey, 10 * s, 0, Math.PI * 2); ctx.fillStyle = KLEUR.wit; ctx.fill();
    ctx.restore();
  }

  function voet(ctx, w, h, s, slug, rechts) {
    ctx.save();
    ctx.font = font(700, 24 * s); spatie(ctx, 0.5 * s); ctx.fillStyle = KLEUR.zacht; ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${HOST}/${slug}`, 72 * s, h - 64 * s);
    if (rechts) { ctx.textAlign = 'right'; ctx.fillText(rechts, w - 72 * s, h - 64 * s); }
    ctx.restore();
  }

  function stippen(ctx, w, y, n, actief, s) {
    const r = 7 * s; const gap = 22 * s;
    const start = (w - (n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) {
      ctx.beginPath(); ctx.arc(start + i * gap, y, i === actief ? r : r * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = i === actief ? KLEUR.goud : 'rgba(217,227,232,0.3)'; ctx.fill();
    }
  }

  function goudKnop(ctx, tekst, x, y, w, h, s) {
    ctx.save();
    const g = ctx.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, KLEUR.goudLicht); g.addColorStop(1, KLEUR.goud);
    ctx.fillStyle = g; rondRect(ctx, x, y, w, h, 22 * s); ctx.fill();
    ctx.fillStyle = KLEUR.navy950; ctx.font = font(900, 34 * s); spatie(ctx, 0); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(tekst + ' \u2192', x + w / 2, y + h / 2 + 2);
    ctx.restore();
  }

  // ── Templates ─────────────────────────────────────────────────────────────
  /** Story 1080×1920. Onderaan (y 1500-1760) blijft ruimte vrij voor de Instagram-sticker. */
  function story(ctx, { s: st, idx, totaal, img, stijl, slug }) {
    const W = 1080, H = 1920, s = 1;
    achtergrond(ctx, W, H, stijl);
    merk(ctx, 72, 96, s);
    ctx.save(); ctx.font = font(700, 26); ctx.fillStyle = KLEUR.zacht; ctx.textAlign = 'right'; ctx.fillText(`${idx + 1}/${totaal}`, W - 72, 135); ctx.restore();
    const cta = st.rol === 'cta';
    let y;
    if (stijl === 1) {
      if (img) foto(ctx, img, 0, 220, W, 860, 0, { rand: false, fadeOnder: true }); else chartDeco(ctx, 72, 260, W - 144, 720, s, idx);
      y = kicker(ctx, st.kicker, 72, 1010, s) + 18;
      y = tekstBlok(ctx, st.titel, { x: 72, y, w: W - 144, max: 118, min: 64, maxRegels: 4 }).onder + 26;
      tekstBlok(ctx, st.tekst, { x: 72, y, w: W - 144, max: 44, min: 32, maxRegels: 5, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.32, sp: 0 });
    } else if (stijl === 2) {
      y = kicker(ctx, st.kicker, 112, 300, s, { lijn: false }) + 24;
      y = tekstBlok(ctx, st.titel, { x: 112, y, w: W - 184, max: 140, min: 70, maxRegels: 5 }).onder + 34;
      y = tekstBlok(ctx, st.tekst, { x: 112, y, w: W - 184, max: 48, min: 32, maxRegels: 6, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.32, sp: 0 }).onder;
      ctx.fillStyle = KLEUR.goud; ctx.fillRect(72, 300, 10, y - 300);
      const top = Math.min(y + 70, 1050);
      if (img) foto(ctx, img, 112, top, W - 224, 1440 - top, 36); else chartDeco(ctx, 112, top, W - 224, 1440 - top, s, idx);
    } else {
      y = kicker(ctx, st.kicker, 72, 300, s) + 22;
      y = tekstBlok(ctx, st.titel, { x: 72, y, w: W - 144, max: 140, min: 66, maxRegels: 4 }).onder + 30;
      y = tekstBlok(ctx, st.tekst, { x: 72, y, w: W - 144, max: 48, min: 32, maxRegels: 5, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.32, sp: 0 }).onder + 60;
      const top = Math.min(y, 1050);
      if (img) foto(ctx, img, 72, top, W - 144, 1450 - top, 36); else chartDeco(ctx, 72, top, W - 144, 1450 - top, s, idx);
    }
    if (cta) {
      ctx.save(); ctx.font = font(800, 40); spatie(ctx, 0); ctx.fillStyle = KLEUR.goud; ctx.textAlign = 'center';
      ctx.fillText(`\u2193 ${st.sticker_tekst || 'Tik op de link'}`, W / 2, 1530); ctx.restore();
    }
    voet(ctx, W, H, s, slug);
  }

  /** Carrousel-slide 1080×1350. Slide 1 = cover, laatste = volgende stap. */
  function slide(ctx, { sl, idx, totaal, img, stijl, slug }) {
    const W = 1080, H = 1350, s = 1;
    achtergrond(ctx, W, H, stijl);
    merk(ctx, 72, 72, s);
    const laatste = idx === totaal - 1;
    if (idx === 0) {
      if (stijl === 1 && img) {
        foto(ctx, img, 0, 170, W, 620, 0, { rand: false, fadeOnder: true });
        const y = tekstBlok(ctx, sl.titel, { x: 72, y: 760, w: W - 144, max: 110, min: 62, maxRegels: 3 }).onder + 20;
        tekstBlok(ctx, sl.tekst, { x: 72, y, w: W - 144, max: 40, min: 30, maxRegels: 3, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.3, sp: 0 });
      } else {
        const y = tekstBlok(ctx, sl.titel, { x: 72, y: 230, w: W - 144, max: 128, min: 66, maxRegels: 4 }).onder + 24;
        const y2 = tekstBlok(ctx, sl.tekst, { x: 72, y, w: W - 144, max: 42, min: 30, maxRegels: 3, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.3, sp: 0 }).onder + 40;
        const top = Math.max(y2, 640);
        if (img) foto(ctx, img, 72, top, W - 144, 1160 - top, 32); else chartDeco(ctx, 72, top, W - 144, 1160 - top, s, stijl);
      }
      ctx.save(); ctx.font = font(800, 28); ctx.fillStyle = KLEUR.goud; ctx.textAlign = 'right'; ctx.fillText('Swipe \u2192', W - 72, 116); ctx.restore();
    } else if (laatste) {
      kicker(ctx, 'Volgende stap', 72, 300, s);
      const y = tekstBlok(ctx, sl.titel, { x: 72, y: 360, w: W - 144, max: 112, min: 60, maxRegels: 4 }).onder + 26;
      const y2 = tekstBlok(ctx, sl.tekst, { x: 72, y, w: W - 144, max: 44, min: 30, maxRegels: 4, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.3, sp: 0 }).onder + 50;
      goudKnop(ctx, 'Link in bio', 72, Math.min(y2, 1000), W - 144, 120, s);
    } else {
      ctx.save(); ctx.font = font(900, stijl === 2 ? 220 : 150); spatie(ctx, -6); ctx.fillStyle = stijl === 2 ? 'rgba(208,160,80,0.22)' : KLEUR.goud;
      ctx.fillText(String(idx).padStart(2, '0'), 66, stijl === 2 ? 440 : 380); ctx.restore();
      const y = tekstBlok(ctx, sl.titel, { x: 72, y: stijl === 2 ? 470 : 420, w: W - 144, max: 96, min: 56, maxRegels: 3 }).onder + 24;
      const y2 = tekstBlok(ctx, sl.tekst, { x: 72, y, w: W - 144, max: 46, min: 30, maxRegels: img ? 4 : 7, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.34, sp: 0 }).onder + 40;
      if (img) { const top = Math.min(Math.max(y2, 700), 860); foto(ctx, img, 72, top, W - 144, 1180 - top, 30); }
      else if (y2 < 900) chartDeco(ctx, 72, Math.max(y2, 860), W - 144, 1180 - Math.max(y2, 860), s, idx);
    }
    stippen(ctx, W, H - 120, totaal, idx, s);
    voet(ctx, W, H, s, slug, `${idx + 1}/${totaal}`);
  }

  /** Vierkant (1080 of 1200). */
  function vierkant(ctx, { v, img, stijl, slug, maat = 1080 }) {
    const W = maat, H = maat, s = maat / 1080;
    achtergrond(ctx, W, H, stijl);
    merk(ctx, 72 * s, 72 * s, s);
    if (stijl === 1 && img) {
      foto(ctx, img, 0, 170 * s, W, 520 * s, 0, { rand: false, fadeOnder: true });
      const y = tekstBlok(ctx, v.titel, { x: 72 * s, y: 640 * s, w: W - 144 * s, max: 100 * s, min: 56 * s, maxRegels: 3 }).onder + 18 * s;
      tekstBlok(ctx, v.sub, { x: 72 * s, y, w: W - 144 * s, max: 40 * s, min: 28 * s, maxRegels: 2, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.3, sp: 0 });
    } else if (stijl === 2) {
      ctx.fillStyle = KLEUR.goud; ctx.fillRect(72 * s, 250 * s, 10 * s, 380 * s);
      const y = tekstBlok(ctx, v.titel, { x: 112 * s, y: 250 * s, w: (img ? 560 : 860) * s, max: 112 * s, min: 58 * s, maxRegels: 4 }).onder + 22 * s;
      tekstBlok(ctx, v.sub, { x: 112 * s, y, w: (img ? 560 : 860) * s, max: 40 * s, min: 28 * s, maxRegels: 3, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.3, sp: 0 });
      if (img) foto(ctx, img, 712 * s, 250 * s, 296 * s, 520 * s, 30 * s); else chartDeco(ctx, 112 * s, 700 * s, W - 224 * s, 240 * s, s, 1);
    } else {
      const y = tekstBlok(ctx, v.titel, { x: 72 * s, y: 220 * s, w: W - 144 * s, max: 112 * s, min: 58 * s, maxRegels: 3 }).onder + 20 * s;
      const y2 = tekstBlok(ctx, v.sub, { x: 72 * s, y, w: W - 144 * s, max: 40 * s, min: 28 * s, maxRegels: 2, gewicht: 500, kleur: KLEUR.tekst, lijn: 1.3, sp: 0 }).onder + 36 * s;
      const top = Math.max(y2, 560 * s);
      if (img) foto(ctx, img, 72 * s, top, W - 144 * s, 960 * s - top, 30 * s); else chartDeco(ctx, 72 * s, top, W - 144 * s, 960 * s - top, s, 0);
    }
    voet(ctx, W, H, s, slug);
  }

  /** OG-beeld 1200×630 voor de pagina (link-voorbeeld op WhatsApp, LinkedIn …). */
  function og(ctx, { p, img, stijl }) {
    const W = 1200, H = 630, s = 0.9;
    achtergrond(ctx, W, H, stijl);
    merk(ctx, 60, 56, s);
    const tw = img ? 660 : 1080;
    let y = kicker(ctx, p.hero_kicker, 60, 150, s) + 16;
    y = tekstBlok(ctx, p.hero_titel, { x: 60, y, w: tw, max: 84, min: 50, maxRegels: 2 }).onder;
    y = tekstBlok(ctx, p.hero_accent, { x: 60, y: y + 4, w: tw, max: 84, min: 50, maxRegels: 2, kleur: KLEUR.goudLicht }).onder;
    if (img) foto(ctx, img, 760, 60, 380, 510, 28); else chartDeco(ctx, 60, Math.min(Math.max(y + 30, 430), 470), W - 120, 110, s, stijl);
    ctx.save(); ctx.font = font(700, 22); ctx.fillStyle = KLEUR.zacht; ctx.fillText(HOST, 60, H - 34); ctx.restore();
  }

  // ── Alles renderen ────────────────────────────────────────────────────────
  function hash(s) { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
  /** Standaardstijl: volgt uit de drop zodat opeenvolgende weken verschillen. */
  function standaardStijl(drop, output) {
    const s = output && output.social && Number.isInteger(output.social.stijl) ? output.social.stijl : null;
    return s != null ? s % 3 : hash((drop && drop.slug) + '|' + ((output && output.format_key) || '')) % 3;
  }

  function nieuwCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  /**
   * → [{ naam, label, breedte, hoogte, canvas }]
   * assets: [{id, publieke_url}] — enkel de beelden die de output gebruikt worden geladen.
   */
  async function renderAlles({ drop, output, assets, stijl }) {
    await laadFonts();
    const map = Object.fromEntries((assets || []).map((a) => [a.id, a]));
    const beeld = async (id) => (id && map[id] ? laadBeeld(map[id].publieke_url) : null);
    const st = Number.isInteger(stijl) ? stijl : standaardStijl(drop, output);
    const uit = [];
    const maak = async (naam, label, w, h, teken) => {
      const c = nieuwCanvas(w, h);
      const ctx = c.getContext('2d');
      await teken(ctx);
      uit.push({ naam, label, breedte: w, hoogte: h, canvas: c });
    };
    const stories = Array.isArray(output.stories) ? output.stories : [];
    for (let i = 0; i < stories.length; i++) {
      const img = await beeld(stories[i].beeld_asset_id);
      await maak(`story-${i + 1}`, `Story ${i + 1}`, 1080, 1920, (ctx) => story(ctx, { s: stories[i], idx: i, totaal: stories.length, img, stijl: st, slug: drop.slug }));
    }
    const slides = (output.post && Array.isArray(output.post.slides)) ? output.post.slides : [];
    for (let i = 0; i < slides.length; i++) {
      const img = await beeld(slides[i].beeld_asset_id);
      await maak(`post-${i + 1}`, `Carrousel ${i + 1}`, 1080, 1350, (ctx) => slide(ctx, { sl: slides[i], idx: i, totaal: slides.length, img, stijl: st, slug: drop.slug }));
    }
    const v = output.vierkant || {};
    const vImg = await beeld(v.beeld_asset_id);
    await maak('vierkant', 'Vierkant 1080', 1080, 1080, (ctx) => vierkant(ctx, { v, img: vImg, stijl: st, slug: drop.slug }));
    const li = output.linkedin || {};
    if (li.beeld === 'slide1' && slides[0]) {
      // Slide 1 als vierkant 1200×1200 (de 4:5-slide past niet in een vierkant).
      const img = await beeld(slides[0].beeld_asset_id);
      await maak('linkedin', 'LinkedIn 1200', 1200, 1200, (ctx) => vierkant(ctx, { v: { titel: slides[0].titel, sub: slides[0].tekst }, img, stijl: st, slug: drop.slug, maat: 1200 }));
    } else {
      await maak('linkedin', 'LinkedIn 1200', 1200, 1200, (ctx) => vierkant(ctx, { v, img: vImg, stijl: st, slug: drop.slug, maat: 1200 }));
    }
    const p = output.pagina || {};
    const ogId = (p.kaarten || []).map((k) => k.beeld_asset_id).find(Boolean) || v.beeld_asset_id;
    const ogImg = await beeld(ogId);
    await maak('og', 'Deelbeeld (OG) 1200×630', 1200, 630, (ctx) => og(ctx, { p, img: ogImg, stijl: st }));
    return { stijl: st, beelden: uit };
  }

  const naarBlob = (c) => new Promise((ok, nok) => {
    try { c.toBlob((b) => (b ? ok(b) : nok(new Error('Canvas leeg'))), 'image/png'); } catch (e) { nok(e); }
  });

  // ── ZIP (STORE, geen compressie) ──────────────────────────────────────────
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  /** [{ naam, data: Uint8Array }] → Uint8Array (zip). */
  function maakZip(bestanden) {
    const enc = new TextEncoder();
    const lokaal = []; const centraal = []; let offset = 0;
    const d = new Date(); const dosTijd = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDatum = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of bestanden) {
      const naam = enc.encode(f.naam); const crc = crc32(f.data); const n = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTijd, true); h.setUint16(12, dosDatum, true); h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true);
      h.setUint16(26, naam.length, true); h.setUint16(28, 0, true);
      lokaal.push(new Uint8Array(h.buffer), naam, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosTijd, true); c.setUint16(14, dosDatum, true); c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true);
      c.setUint16(28, naam.length, true); c.setUint32(42, offset, true);
      centraal.push(new Uint8Array(c.buffer), naam);
      offset += 30 + naam.length + n;
    }
    const cGrootte = centraal.reduce((s, x) => s + x.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, bestanden.length, true); e.setUint16(10, bestanden.length, true);
    e.setUint32(12, cGrootte, true); e.setUint32(16, offset, true);
    const delenZip = [...lokaal, ...centraal, new Uint8Array(e.buffer)];
    const uit = new Uint8Array(delenZip.reduce((s, x) => s + x.length, 0));
    let p = 0; for (const x of delenZip) { uit.set(x, p); p += x.length; }
    return uit;
  }

  function download(blob, naam) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = naam;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  window.__cmSocial = { renderAlles, maakZip, crc32, standaardStijl, laadFonts, STIJLEN, _templates: { story, slide, vierkant, og, tekstBlok, wrap }, naarBlob, download };

  // ── Werkblad-integratie ───────────────────────────────────────────────────
  const toast = (m) => { if (window.KV && typeof window.KV.toast === 'function') window.KV.toast(m); };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const post = (url, b) => window.KV.authedJson(url, { method: 'POST', body: JSON.stringify(b) });

  const sv = window.__cmSv = window.__cmSv || { sleutel: null, bezig: false, stijl: null, beelden: [], fout: null, opslaan: false };

  function wbState() { return window.__cmWerkblad || null; }
  function sleutelVan(wb) { return wb && wb.drop ? `${wb.drop.id}|${wb.drop.versie}|${JSON.stringify(wb.output && [wb.output.stories, wb.output.post, wb.output.vierkant, wb.output.linkedin, wb.output.pagina && [wb.output.pagina.hero_kicker, wb.output.pagina.hero_titel, wb.output.pagina.hero_accent]])}|${sv.stijl}` : null; }

  async function zorgVoorRender() {
    const wb = wbState();
    if (!wb || !wb.drop || !wb.output) return;
    const k = sleutelVan(wb);
    if (sv.sleutel === k || sv.bezig) return;
    sv.bezig = true; sv.fout = null;
    try {
      const r = await renderAlles({ drop: wb.drop, output: wb.output, assets: wb.assets, stijl: sv.stijl == null ? undefined : sv.stijl });
      sv.beelden = r.beelden; sv.stijl = r.stijl; sv.sleutel = sleutelVan(wb);
    } catch (e) { sv.fout = e && e.message ? e.message : 'Renderen mislukt'; console.error('[contentmachine-social] renderen mislukt:', e); }
    sv.bezig = false;
    const el = document.getElementById('cm-social');
    if (el) el.innerHTML = paneelInhoud(el.getAttribute('data-filter') || 'alles');
  }

  /** Paneel met de echte beelden (vervangt de ruwe voorvertoning in Stories/Post/LinkedIn/Pagina). */
  window.__cmSocialPaneel = function (filter) {
    queueMicrotask(zorgVoorRender);
    return `<div id="cm-social" data-filter="${esc(filter)}">${paneelInhoud(filter)}</div>`;
  };

  const FILTER = { stories: (b) => b.naam.startsWith('story-'), post: (b) => b.naam.startsWith('post-') || b.naam === 'vierkant', linkedin: (b) => b.naam === 'linkedin', pagina: (b) => b.naam === 'og', alles: () => true };

  function paneelInhoud(filter) {
    const wb = wbState();
    const kop = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <span style="font-size:12px;color:var(--text-2)">Stijl: <b>${esc(STIJLEN[sv.stijl] || '…')}</b></span>
      <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__cmSocialStijl()">Andere stijl</button>
      <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__cmSocialZip()">⬇ Alle beelden (zip)</button>
      <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__cmSocialOpslaan()" ${sv.opslaan ? 'disabled' : ''}>${sv.opslaan ? 'Opslaan…' : 'Opslaan in Storage'}</button>
      ${wb && wb.output && wb.output.social && wb.output.social.opgeslagen_op ? `<span style="font-size:11px;color:var(--text-3)">opgeslagen ${esc(new Date(wb.output.social.opgeslagen_op).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</span>` : ''}</div>`;
    if (sv.fout) return `${kop}<div style="color:var(--rose);font-size:12px">${esc(sv.fout)}</div>`;
    if (sv.bezig || !sv.beelden.length || sv.sleutel !== sleutelVan(wb)) return `${kop}<div style="color:var(--text-3);font-size:12px;padding:8px 0">Beelden tekenen…</div>`;
    const lijst = sv.beelden.filter(FILTER[filter] || FILTER.alles);
    return `${kop}<div class="cm-sv-rij">${lijst.map((b) => {
      const url = b._url || (b._url = b.canvas.toDataURL('image/png'));
      const bw = b.breedte > b.hoogte ? 300 : b.hoogte > 1500 ? 170 : 210;
      return `<div style="flex:0 0 auto;width:${bw}px"><img src="${url}" alt="${esc(b.label)}" style="width:100%;border-radius:8px;border:1px solid var(--border);display:block">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:3px"><span style="color:var(--text-3)">${esc(b.label)}</span><a href="javascript:void(0)" onclick="__cmSocialDownload('${esc(b.naam)}')">PNG</a></div></div>`;
    }).join('')}</div>`;
  }

  window.__cmSocialStijl = () => { sv.stijl = ((sv.stijl == null ? 0 : sv.stijl) + 1) % 3; sv.sleutel = null; const el = document.getElementById('cm-social'); if (el) el.innerHTML = paneelInhoud(el.getAttribute('data-filter')); zorgVoorRender(); };
  window.__cmSocialDownload = async (naam) => {
    const b = sv.beelden.find((x) => x.naam === naam); const wb = wbState();
    if (!b) return;
    try { download(await naarBlob(b.canvas), `drop-${wb.drop.slug}-${naam}.png`); } catch (e) { toast('Download mislukt: ' + (e.message || e)); }
  };
  async function zorgKlaar() {
    const wb = wbState();
    if (sv.sleutel !== sleutelVan(wb) || !sv.beelden.length) { sv.sleutel = null; await zorgVoorRender(); }
    if (!sv.beelden.length) throw new Error(sv.fout || 'Geen beelden');
  }
  window.__cmSocialZip = async () => {
    const wb = wbState();
    try {
      toast('Zip maken…');
      await zorgKlaar();
      const bestanden = [];
      for (const b of sv.beelden) bestanden.push({ naam: `${b.naam}.png`, data: new Uint8Array(await (await naarBlob(b.canvas)).arrayBuffer()) });
      const teksten = typeof window.__cmWbAlleTeksten === 'function' ? window.__cmWbAlleTeksten() : '';
      if (teksten) bestanden.push({ naam: 'teksten.txt', data: new TextEncoder().encode(teksten) });
      download(new Blob([maakZip(bestanden)], { type: 'application/zip' }), `drop-${wb.drop.slug}-beelden.zip`);
      window.__cmSocialOpslaan(true);
    } catch (e) { toast('Zip mislukt: ' + (e.message || e)); console.error('[contentmachine-social] zip mislukt:', e); }
  };
  /** Alle beelden naar Storage drops/<slug>/social/ + lijst in output.social. */
  window.__cmSocialOpslaan = async (stil) => {
    const wb = wbState();
    if (sv.opslaan || !wb || !wb.drop) return;
    sv.opslaan = true;
    const el = document.getElementById('cm-social'); if (el) el.innerHTML = paneelInhoud(el.getAttribute('data-filter'));
    try {
      await zorgKlaar();
      await window._authSharedReady;
      const bestanden = {};
      for (const b of sv.beelden) {
        const u = await post('/api/contentmachine/assets', { actie: 'social-upload-url', drop_id: wb.drop.id, naam: b.naam });
        const blob = await naarBlob(b.canvas);
        const up = await window.supabase.storage.from(u.bucket || 'content').uploadToSignedUrl(u.pad, u.token, blob, { contentType: 'image/png', upsert: true });
        if (up.error) throw new Error(up.error.message || 'upload');
        bestanden[b.naam] = { url: u.publieke_url + '?v=' + Date.now(), breedte: b.breedte, hoogte: b.hoogte };
      }
      const r = await post('/api/contentmachine/drops', { actie: 'social', id: wb.drop.id, stijl: sv.stijl, bestanden });
      if (wb.output) wb.output.social = r.social; if (wb.drop.output) wb.drop.output.social = r.social;
      if (!stil) toast(`${Object.keys(bestanden).length} beelden opgeslagen in Storage.`);
    } catch (e) {
      toast('Opslaan in Storage mislukt: ' + ((e && e.body && e.body.error) || e.message || e));
      console.error('[contentmachine-social] opslaan mislukt:', e);
    }
    sv.opslaan = false;
    const el2 = document.getElementById('cm-social'); if (el2) el2.innerHTML = paneelInhoud(el2.getAttribute('data-filter'));
  };
})();
