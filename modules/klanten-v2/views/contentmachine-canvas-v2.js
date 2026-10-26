// modules/klanten-v2/views/contentmachine-canvas-v2.js
//
// Contentmachine 2.0 — tekenkit voor alle canvas-beelden (blokframe voor de mail,
// social-templates op het niveau van de Instagram-reeks). Puur canvas, geen externe
// code: fonts zelf-gehost (Inter Tight voor koppen zoals de IG-posts, Inter voor tekst,
// /img/contentmachine/fonts, OFL), het echte logo (/img/contentmachine/logo).
//
//   window.__cmCanvas = { KLEUR, laadAlles, laadBeeld, font, spatie, rondRect, tekst,
//                         eyebrow, logo, cover, kaart, verloop, naarBlob }
(function () {
  'use strict';
  const KLEUR = {
    navy950: '#0B1E2A', navy900: '#112B3B', navy800: '#17364A', navy700: '#1F455F', navy600: '#2A5876',
    goud: '#D0A050', goudLicht: '#E2B866', goudInkt: '#A7803F', wit: '#FFFFFF', tekst: '#D9E3E8', zacht: '#8FA7B5',
    inkt: '#13293A', inkt2: '#41596C', licht: '#F4F6F8', lijn: 'rgba(217,227,232,.12)', bull: '#3FC79A', bear: '#E5675C',
  };
  const BASIS = () => window.__cmFontBasis || '/img/contentmachine/fonts/';
  const LOGO = () => window.__cmLogoBasis || '/img/contentmachine/logo/';

  // ── laden ─────────────────────────────────────────────────────────────────
  let klaar = null;
  const logos = {};
  function laadAlles() {
    if (klaar) return klaar;
    const fonts = typeof FontFace === 'undefined' ? [] : [
      ['DFOInter', 'inter-latin-500-normal', 500], ['DFOInter', 'inter-latin-700-normal', 700], ['DFOInter', 'inter-latin-800-normal', 800], ['DFOInter', 'inter-latin-900-normal', 900],
      ['DFOTight', 'inter-tight-latin-700-normal', 700], ['DFOTight', 'inter-tight-latin-800-normal', 800],
    ].map(([fam, bestand, w]) => new FontFace(fam, `url(${BASIS()}${bestand}.woff2) format('woff2')`, { weight: String(w) })
      .load().then((f) => { document.fonts.add(f); return f; }).catch((e) => { console.error('[cm-canvas] font', bestand, e); return null; }));
    const lg = ['logo', 'logo-wit'].map((n) => laadBeeld(LOGO() + n + '.png').then((img) => { logos[n] = img; }));
    klaar = Promise.all([...fonts, ...lg]);
    return klaar;
  }
  const cache = new Map();
  function laadBeeld(url) {
    if (!url) return Promise.resolve(null);
    if (cache.has(url)) return cache.get(url);
    const p = new Promise((ok) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => ok(img);
      img.onerror = () => { console.error('[cm-canvas] beeld laden mislukt:', url); ok(null); };
      img.src = url;
    });
    cache.set(url, p);
    return p;
  }

  // ── basis ─────────────────────────────────────────────────────────────────
  /** soort: 'kop' = Inter Tight (koppen), anders Inter. */
  const font = (w, px, soort) => `${w} ${Math.round(px)}px ${soort === 'kop' ? 'DFOTight, DFOInter' : 'DFOInter'}, Inter, Arial, sans-serif`;
  function spatie(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; }
  function rondRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function verloop(ctx, x0, y0, x1, y1, stops) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([t, k]) => g.addColorStop(t, k));
    return g;
  }

  /** "a **b** c" → woorden met accent-vlag; \n = harde regel. */
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
  function regels(ctx, woorden, maxW) {
    const rij = []; let huidig = []; let breedte = 0;
    const sp = ctx.measureText(' ').width;
    for (const w of woorden) {
      if (w.breek) { rij.push(huidig); huidig = []; breedte = 0; continue; }
      const b = ctx.measureText(w.woord).width;
      if (huidig.length && breedte + sp + b > maxW) { rij.push(huidig); huidig = []; breedte = 0; }
      huidig.push({ ...w, b }); breedte += (huidig.length > 1 ? sp : 0) + b;
    }
    if (huidig.length) rij.push(huidig);
    return rij;
  }

  /**
   * Tekst met woordafbreking en accent. o: { x, y (bovenkant), maxW, px, w (gewicht), soort ('kop'),
   * kleur, accentKleur, accent: 'kleur' | 'marker', lh (factor), maxRegels, minPx (verklein tot het past),
   * spatie, uitlijn: 'left'|'center' }. → y onder de laatste regel.
   */
  function tekst(ctx, inhoud, o) {
    const woorden = delen(inhoud);
    let px = o.px;
    let r;
    for (;;) {
      ctx.font = font(o.w || 700, px, o.soort);
      spatie(ctx, o.spatie != null ? o.spatie * px : (o.soort === 'kop' ? -0.035 * px : 0));
      r = regels(ctx, woorden, o.maxW);
      if (!o.maxRegels || r.length <= o.maxRegels || !o.minPx || px <= o.minPx) break;
      px = Math.max(o.minPx, px - Math.max(1, px * 0.06));
    }
    if (o.maxRegels && r.length > o.maxRegels) r = r.slice(0, o.maxRegels);
    const lh = px * (o.lh || (o.soort === 'kop' ? 1.02 : 1.4));
    ctx.textBaseline = 'alphabetic';
    let y = o.y;
    const sp = ctx.measureText(' ').width;
    r.forEach((rij) => {
      const breedte = rij.reduce((a, w, i) => a + w.b + (i ? sp : 0), 0);
      let x = o.uitlijn === 'center' ? o.x + (o.maxW - breedte) / 2 : o.x;
      const basis = y + px * 0.86;
      rij.forEach((w, i) => {
        if (i) x += sp;
        if (w.accent && o.accent === 'marker') {
          ctx.save(); ctx.fillStyle = 'rgba(208,160,80,0.42)';
          ctx.fillRect(x - px * 0.04, basis - px * 0.24, w.b + px * 0.08 + (i < rij.length - 1 && rij[i + 1].accent ? sp : 0), px * 0.3);
          ctx.restore();
          ctx.fillStyle = o.kleur;
        } else {
          ctx.fillStyle = w.accent ? (o.accentKleur || KLEUR.goud) : o.kleur;
        }
        ctx.fillText(w.woord, x, basis);
        x += w.b;
      });
      y += lh;
    });
    spatie(ctx, 0);
    return y;
  }

  /** Eyebrow zoals de IG-reeks: hoofdletters, ruime spatiëring, lijn erachter. → y onder. */
  function eyebrow(ctx, t, x, y, { px = 22, kleur = KLEUR.goud, lijn = true, lijnW = 54 } = {}) {
    if (!t) return y;
    ctx.save();
    ctx.font = font(800, px); spatie(ctx, px * 0.2); ctx.fillStyle = kleur; ctx.textBaseline = 'middle';
    const s = String(t).toUpperCase();
    ctx.fillText(s, x, y + px / 2);
    if (lijn) {
      const w = ctx.measureText(s).width;
      ctx.fillRect(x + w + px * 0.9, y + px / 2 - 1, lijnW, 2);
    }
    ctx.restore();
    return y + px;
  }

  /** Het echte logo (wit op donker, of donker op licht). h = hoogte in px. */
  function logo(ctx, x, y, h, { wit = true } = {}) {
    const img = logos[wit ? 'logo-wit' : 'logo'];
    if (!img) return;
    const w = h * (img.width / img.height);
    ctx.drawImage(img, x, y, w, h);
    return w;
  }

  /** Beeld als "cover" in een kader (focusY 0..1 = welk deel zichtbaar blijft). */
  function cover(ctx, img, x, y, w, h, { focusY = 0.4, focusX = 0.5 } = {}) {
    if (!img) return;
    const s = Math.max(w / img.width, h / img.height);
    const sw = w / s, sh = h / s;
    const sx = Math.max(0, Math.min(img.width - sw, (img.width - sw) * focusX));
    const sy = Math.max(0, Math.min(img.height - sh, (img.height - sh) * focusY));
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  /** UI-kaart met schaduw (zoals de IG-posts met platform-screens). */
  function kaart(ctx, x, y, w, h, { r = 28, vul = '#0d2230', rand = 'rgba(217,227,232,.10)', schaduw = 'rgba(0,0,0,.45)', blur = 60, dy = 24 } = {}) {
    ctx.save();
    ctx.shadowColor = schaduw; ctx.shadowBlur = blur; ctx.shadowOffsetY = dy;
    rondRect(ctx, x, y, w, h, r); ctx.fillStyle = vul; ctx.fill();
    ctx.restore();
    if (rand) { ctx.save(); rondRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r); ctx.strokeStyle = rand; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore(); }
  }

  const naarBlob = (c, type = 'image/png', q) => new Promise((ok, nok) => {
    try { c.toBlob((b) => (b ? ok(b) : nok(new Error('Canvas leeg'))), type, q); } catch (e) { nok(e); }
  });

  window.__cmCanvas = { KLEUR, laadAlles, laadBeeld, font, spatie, rondRect, verloop, delen, tekst, eyebrow, logo, cover, kaart, naarBlob };
})();
