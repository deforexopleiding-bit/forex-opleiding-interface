// modules/klanten-v2/views/contentmachine-social2-v2.js
//
// Contentmachine 2.0 — social-beelden op het niveau van de Instagram-reeks van DFO
// (docs/contentmachine/v2/stijl-instagram/). Getekend op canvas met de tekenkit
// (contentmachine-canvas-v2.js) en, voor de kaart-variant, het blokframe van de pagina
// (contentmachine-blokframe-v2.js).
//
// Elk beeld volgt hetzelfde systeem: echte logo linksboven, teller "01 / 05" rechtsboven,
// eyebrow met lijn, grote vette kop (Inter Tight) met gouden accentwoorden, subtekst,
// onderaan "@deforexopleiding.nl" en "SWIPE →". Vijf varianten:
//   foto (masterclassfoto full-bleed + donker verloop) · donker · licht (navy kop, gouden
//   marker) · data (één enorm getal) · kaart (frame van een blok als UI-kaart met schaduw).
//
// Formaten: story 1080×1920 · post (carrousel) 1080×1350 · vierkant 1080×1080 ·
// linkedin 1080×1350 · og 1200×630. Namen = SOCIAL_NAAM_RE in contentmachine-core.js.
//
//   window.__cmSocial2 = { renderAlles, tekenBeeld, FORMATEN, isV2 }
(function () {
  'use strict';
  const K = () => window.__cmCanvas;
  const BF = () => window.__cmBlokFrame;
  const VARIANTEN = ['foto', 'donker', 'licht', 'data', 'kaart'];
  const FORMATEN = { story: [1080, 1920], post: [1080, 1350], vierkant: [1080, 1080], linkedin: [1080, 1350], og: [1200, 630] };
  const HANDLE = '@deforexopleiding.nl';

  const isV2 = (o) => !!(o && o.post && Array.isArray(o.post.slides) && o.post.slides.length && o.post.slides.every((s) => s && VARIANTEN.includes(s.variant)));
  const nr = (n) => String(n).padStart(2, '0');

  // ── palet per variant ─────────────────────────────────────────────────────
  function palet(variant) {
    const c = K().KLEUR;
    if (variant === 'licht') return { licht: true, kop: c.inkt, tekst: c.inkt2, zacht: '#7D8E9B', eyebrow: c.goudInkt, accent: c.goudInkt, swipe: c.goudInkt };
    return { licht: false, kop: '#F4F6F8', tekst: 'rgba(233,239,243,.86)', zacht: 'rgba(217,227,232,.62)', eyebrow: c.goud, accent: c.goud, swipe: c.goud };
  }

  function achtergrond(ctx, W, H, variant) {
    const c = K();
    if (variant === 'licht') {
      ctx.fillStyle = c.verloop(ctx, 0, 0, 0, H, [[0, '#F6F7F9'], [1, '#EEF1F4']]);
      ctx.fillRect(0, 0, W, H);
      return;
    }
    // donker navy zoals de reeks: bovenaan het diepst, naar onder iets blauwer
    ctx.fillStyle = c.verloop(ctx, 0, 0, W * 0.25, H, [[0, '#13212E'], [0.55, '#1A2C3D'], [1, '#23384C']]);
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * 0.95, H * 0.02, 0, W * 0.95, H * 0.02, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(208,160,80,.07)'); g.addColorStop(1, 'rgba(208,160,80,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // ── chrome (logo, teller, handle, swipe) ──────────────────────────────────
  function chrome(ctx, W, H, pal, o) {
    const c = K();
    const s = W / 1080;
    const m = o.marge;
    const boven = o.boven;
    c.logo(ctx, m, boven, 72 * s, { wit: !pal.licht });
    ctx.save();
    ctx.textBaseline = 'middle';
    if (o.teller) {
      ctx.font = c.font(700, 19 * s); c.spatie(ctx, 19 * s * 0.22); ctx.fillStyle = pal.zacht; ctx.textAlign = 'right';
      ctx.fillText(o.teller, W - m, boven + 36 * s);
    }
    const onder = H - o.onder;
    if (o.handle !== false) {
      ctx.font = c.font(600, 19 * s); c.spatie(ctx, 0); ctx.fillStyle = pal.zacht; ctx.textAlign = 'left';
      ctx.fillText(o.handle || HANDLE, m, onder);
    }
    if (o.swipe) {
      ctx.font = c.font(800, 19 * s); c.spatie(ctx, 19 * s * 0.22); ctx.fillStyle = pal.swipe; ctx.textAlign = 'right';
      ctx.fillText(o.swipe, W - m, onder);
    }
    ctx.restore();
  }

  // ── tekstblok: eyebrow + kop + subtekst ───────────────────────────────────
  /** Hoogte van het tekstblok zonder te tekenen (meten via een off-screen canvas). */
  function meetTekst(b, o) {
    const cv = document.createElement('canvas'); cv.width = 10; cv.height = 10;
    return tekstBlok(cv.getContext('2d'), b, { ...o, y: 0, droog: true }) ;
  }
  function tekstBlok(ctx, b, o) {
    const c = K();
    const pal = o.pal;
    let y = o.y;
    const doel = o.droog ? { ...pal, eyebrow: 'rgba(0,0,0,0)', kop: 'rgba(0,0,0,0)', tekst: 'rgba(0,0,0,0)', accent: 'rgba(0,0,0,0)' } : pal;
    if (b.eyebrow) {
      if (!o.droog) c.eyebrow(ctx, b.eyebrow, o.x, y, { px: o.eyebrowPx, kleur: doel.eyebrow, lijnW: 58 * o.s });
      y += o.eyebrowPx + o.eyebrowGap;
    }
    if (o.droog) { ctx.save(); ctx.globalAlpha = 0; }
    y = c.tekst(ctx, b.titel || '', { x: o.x, y, maxW: o.maxW, px: o.kopPx, w: 800, soort: 'kop', kleur: doel.kop, accentKleur: doel.accent, accent: pal.licht ? 'marker' : 'kleur', lh: 1.0, maxRegels: o.kopRegels, minPx: o.kopPx * 0.62 });
    if (b.tekst) {
      y += o.tekstGap;
      y = c.tekst(ctx, b.tekst, { x: o.x, y, maxW: o.tekstW || o.maxW, px: o.tekstPx, w: 500, kleur: doel.tekst, accentKleur: pal.licht ? K().KLEUR.inkt : '#FFFFFF', lh: 1.38, maxRegels: o.tekstRegels || 4, minPx: o.tekstPx * 0.8 });
    }
    if (o.droog) ctx.restore();
    return y;
  }

  /** Maten per formaat (alles geschaald op een breedte van 1080). */
  function maten(soort, W, H) {
    const s = W / 1080;
    const basis = {
      s, marge: 72 * s, boven: 60 * s, onder: 64 * s,
      eyebrowPx: 20 * s, eyebrowGap: 30 * s, kopPx: 92 * s, kopRegels: 5, tekstGap: 34 * s, tekstPx: 31 * s, tekstRegels: 4,
    };
    if (soort === 'story') return { ...basis, marge: 84 * s, boven: 200 * s, onder: 230 * s, kopPx: 112 * s, kopRegels: 6, tekstPx: 38 * s, tekstGap: 40 * s, eyebrowPx: 24 * s, tekstRegels: 5 };
    if (soort === 'vierkant') return { ...basis, kopPx: 88 * s, kopRegels: 4, tekstRegels: 3 };
    if (soort === 'og') return { ...basis, s: H / 630, marge: 64, boven: 44, onder: 46, eyebrowPx: 18, eyebrowGap: 22, kopPx: 64, kopRegels: 3, tekstPx: 24, tekstGap: 20, tekstRegels: 2 };
    return basis;
  }

  // ── varianten ─────────────────────────────────────────────────────────────
  async function tekenFoto(ctx, W, H, b, m, ctx2) {
    const c = K();
    const a = b.beeld_asset_id && ctx2.assets[b.beeld_asset_id];
    const img = a ? await c.laadBeeld(a.publieke_url) : null;
    if (img) c.cover(ctx, img, 0, 0, W, H, { focusY: 0.35 });
    else achtergrond(ctx, W, H, 'donker');
    const pal = palet('foto');
    // tekstblok onderaan: meten, dan het verloop erachter zetten
    const x = m.marge; const maxW = W - 2 * m.marge;
    const hoog = meetTekst(b, { pal, x, maxW, ...m });
    const yTekst = H - m.onder - 64 * m.s - hoog;
    const g = ctx.createLinearGradient(0, Math.max(0, yTekst - H * 0.28), 0, H);
    g.addColorStop(0, 'rgba(14,24,34,0)'); g.addColorStop(0.35, 'rgba(14,24,34,.72)'); g.addColorStop(1, 'rgba(12,21,30,.96)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const t = ctx.createLinearGradient(0, 0, 0, H * 0.18);
    t.addColorStop(0, 'rgba(10,18,26,.55)'); t.addColorStop(1, 'rgba(10,18,26,0)');
    ctx.fillStyle = t; ctx.fillRect(0, 0, W, H * 0.18);
    tekstBlok(ctx, b, { pal, x, maxW, y: yTekst, ...m });
    return pal;
  }

  function tekenEffen(ctx, W, H, b, m, variant, soort) {
    achtergrond(ctx, W, H, variant);
    const pal = palet(variant);
    const x = m.marge; const maxW = W - 2 * m.marge;
    const hoog = meetTekst(b, { pal, x, maxW, ...m });
    // carrousel zoals de reeks: het blok in het bovenste deel (de swipe trekt verder);
    // story, vierkant en LinkedIn staan op zich: optisch gecentreerd. Nooit tegen het logo.
    const vrij = H - m.boven - m.onder - 120 * m.s;
    const factor = soort === 'post' ? 0.35 : 0.46;
    const plafond = soort === 'post' ? vrij * 0.22 : vrij;
    const y = m.boven + 90 * m.s + Math.max(0, Math.min(plafond, (vrij - hoog) * factor));
    tekstBlok(ctx, b, { pal, x, maxW, y, ...m });
    return pal;
  }

  function getalTekst(g) {
    const d = Number.isInteger(g.decimalen) ? g.decimalen : (Number.isInteger(g.waarde) ? 0 : 1);
    const n = Number(g.waarde).toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
    return `${g.prefix || ''}${n}${g.suffix || ''}`;
  }

  function tekenData(ctx, W, H, b, m) {
    const c = K();
    achtergrond(ctx, W, H, 'donker');
    const pal = palet('data');
    const x = m.marge; const maxW = W - 2 * m.marge;
    const g = b.getal || { waarde: 0, label: '' };
    const getal = getalTekst(g);
    // het getal vult de breedte (zoals "20.244" in de reeks)
    let px = m.kopPx * 3.2;
    ctx.font = c.font(800, px, 'kop'); c.spatie(ctx, -0.055 * px);
    const w0 = ctx.measureText(getal).width;
    if (w0 > maxW) px = px * maxW / w0;
    px = Math.min(px, (H * 0.3));
    const labelB = { eyebrow: b.eyebrow, titel: b.titel, tekst: b.tekst };
    const hoogTekst = meetTekst({ titel: labelB.titel, tekst: labelB.tekst }, { pal, x, maxW, ...m, kopPx: m.kopPx * 0.5, kopRegels: 3 });
    const totaal = m.eyebrowPx + m.eyebrowGap + px * 0.95 + 40 * m.s + hoogTekst;
    const vrij = H - m.boven - m.onder - 120 * m.s;
    let y = m.boven + 90 * m.s + Math.max(0, (vrij - totaal) * 0.3);
    if (b.eyebrow) { c.eyebrow(ctx, b.eyebrow, x, y, { px: m.eyebrowPx, kleur: pal.eyebrow, lijnW: 58 * m.s }); y += m.eyebrowPx + m.eyebrowGap * 0.6; }
    ctx.save();
    ctx.font = c.font(800, px, 'kop'); c.spatie(ctx, -0.055 * px); ctx.fillStyle = '#F4F6F8'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(getal, x - px * 0.04, y + px * 0.86);
    ctx.restore();
    y += px * 0.95 + 40 * m.s;
    const labelTitel = labelB.titel || g.label;
    tekstBlok(ctx, { titel: labelTitel, tekst: labelB.tekst || (labelB.titel ? g.label : '') }, { pal, x, maxW, y, ...m, kopPx: m.kopPx * 0.5, kopRegels: 3, tekstGap: m.tekstGap * 0.8 });
    return pal;
  }

  async function tekenKaart(ctx, W, H, b, m, ctx2) {
    const licht = ctx2.thema === 'licht';
    const variant = licht ? 'licht' : 'donker';
    achtergrond(ctx, W, H, variant);
    const pal = palet(variant);
    const x = m.marge; const maxW = W - 2 * m.marge;
    const kopPx = m.kopPx * 0.82;
    const yNa = tekstBlok(ctx, b, { pal, x, maxW, y: m.boven + 120 * m.s, ...m, kopPx, kopRegels: 3, tekstRegels: 2 });
    const pagina = ctx2.pagina || {};
    const bf = BF();
    const { blok } = bf.kiesBlok(pagina, b.blok_index);
    // kaart: licht gekanteld en tot voorbij de rand, zoals de platform-posts van de reeks
    const ky = yNa + 56 * m.s;
    const kh = Math.max(260 * m.s, H - ky - m.onder - 90 * m.s);
    const kw = Math.min(W - x + 40 * m.s, kh * 1.7);
    let payouts = [];
    if (blok && blok.type === 'payout-muur') payouts = await Promise.all(((blok.props && blok.props.payouts) || []).slice(0, 3).map((p) => K().laadBeeld(ctx2.assets[p.asset_id] && ctx2.assets[p.asset_id].publieke_url)));
    ctx.save();
    ctx.translate(x + kw / 2, ky + kh / 2); ctx.rotate(-0.035); ctx.translate(-(x + kw / 2), -(ky + kh / 2));
    bf.tekenKaart(ctx, blok, { x: x + 8 * m.s, y: ky, w: kw, h: kh, licht }, { payouts });
    ctx.restore();
    return pal;
  }

  /** Linkstickervak voor de cta-story (de echte sticker komt erop in Instagram). */
  function sticker(ctx, W, y, tekst, url, s, pal) {
    const c = K();
    ctx.save();
    ctx.font = c.font(800, 40 * s); c.spatie(ctx, 0);
    const label = String(tekst || 'Lees de weekeditie').toUpperCase();
    const tw = ctx.measureText(label).width;
    const bw = tw + 160 * s, bh = 104 * s;
    const bx = (W - bw) / 2;
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 40 * s; ctx.shadowOffsetY = 14 * s;
    c.rondRect(ctx, bx, y, bw, bh, 22 * s); ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.shadowColor = 'transparent';
    // link-icoon (twee schakels)
    const ix = bx + 54 * s, iy = y + bh / 2;
    ctx.strokeStyle = '#2E7CF6'; ctx.lineWidth = 7 * s; ctx.lineCap = 'round';
    ctx.save(); ctx.translate(ix, iy); ctx.rotate(-Math.PI / 4);
    c.rondRect(ctx, -26 * s, -10 * s, 30 * s, 20 * s, 10 * s); ctx.stroke();
    c.rondRect(ctx, -4 * s, -10 * s, 30 * s, 20 * s, 10 * s); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#2E7CF6'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(label, bx + 104 * s, iy + 2 * s);
    // korte URL eronder
    ctx.font = c.font(600, 28 * s); ctx.fillStyle = pal.zacht; ctx.textAlign = 'center';
    ctx.fillText(url, W / 2, y + bh + 54 * s);
    ctx.restore();
    return y + bh + 80 * s;
  }

  /**
   * Teken één beeld. spec = { variant, eyebrow, titel, tekst, beeld_asset_id, getal, blok_index, rol, sticker_tekst }
   * o = { soort: 'story'|'post'|'vierkant'|'linkedin'|'og', teller, swipe, assets (id→rij), pagina, thema, slug }
   * → canvas
   */
  async function tekenBeeld(spec, o) {
    const c = K(); await c.laadAlles();
    const [W, H] = FORMATEN[o.soort] || FORMATEN.post;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const m = maten(o.soort, W, H);
    const b = { ...spec };
    const variant = VARIANTEN.includes(b.variant) ? b.variant : 'donker';
    const ctx2 = { assets: o.assets || {}, pagina: o.pagina, thema: o.thema };
    let pal;
    const cta = o.soort === 'story' && b.rol === 'cta';
    if (cta) {
      // cta-story: kop + linkstickervak in het midden, altijd effen (de sticker moet opvallen)
      const v = variant === 'licht' ? 'licht' : 'donker';
      achtergrond(ctx, W, H, v); pal = palet(v);
      const x = m.marge; const maxW = W - 2 * m.marge;
      const hoog = meetTekst(b, { pal, x, maxW, ...m });
      const y0 = Math.max(m.boven + 160 * m.s, (H - hoog - 300 * m.s) / 2);
      const yNa = tekstBlok(ctx, b, { pal, x, maxW, y: y0, ...m });
      sticker(ctx, W, yNa + 90 * m.s, b.sticker_tekst, o.korteUrl || '', m.s, pal);
    } else if (variant === 'foto') pal = await tekenFoto(ctx, W, H, b, m, ctx2);
    else if (variant === 'data' && b.getal) pal = tekenData(ctx, W, H, b, m);
    else if (variant === 'kaart') pal = await tekenKaart(ctx, W, H, b, m, ctx2);
    else pal = tekenEffen(ctx, W, H, b, m, variant === 'licht' ? 'licht' : 'donker', o.soort);
    chrome(ctx, W, H, pal, { marge: m.marge, boven: m.boven, onder: m.onder, teller: o.teller, swipe: o.swipe, handle: o.handle });
    return cv;
  }

  /**
   * Alle social-beelden van een drop (2.0). → [{ naam, canvas, breedte, hoogte, kanaal }]
   * assets = [{ id, publieke_url, soort }].
   */
  async function renderAlles({ drop, output, assets = [] }) {
    const per = Object.fromEntries((assets || []).map((a) => [a.id, a]));
    const pagina = output.pagina || {};
    const basis = { assets: per, pagina, thema: pagina.thema, slug: drop.slug, korteUrl: `training.deforexopleiding.nl/${drop.slug}` };
    const uit = [];
    const zet = async (naam, kanaal, spec, o) => {
      const cv = await tekenBeeld(spec, { ...basis, ...o });
      uit.push({ naam, kanaal, canvas: cv, breedte: cv.width, hoogte: cv.height });
    };
    const st = output.stories || [];
    for (let i = 0; i < st.length; i++) await zet(`story-${i + 1}`, 'story', st[i], { soort: 'story' });
    const sl = (output.post && output.post.slides) || [];
    for (let i = 0; i < sl.length; i++) {
      const laatste = i === sl.length - 1;
      await zet(`post-${i + 1}`, 'post', sl[i], { soort: 'post', teller: `${nr(i + 1)} / ${nr(sl.length)}`, swipe: laatste ? 'LINK IN BIO →' : 'SWIPE →' });
    }
    if (output.vierkant) await zet('vierkant', 'vierkant', output.vierkant, { soort: 'vierkant', swipe: 'WEEKEDITIE →' });
    if (output.linkedin && output.linkedin.beeld) await zet('linkedin', 'linkedin', output.linkedin.beeld, { soort: 'linkedin', handle: 'deforexopleiding.nl', swipe: 'LEES DE WEEKEDITIE →' });
    // OG-beeld (delen van de pagina): slide 1 in liggend formaat, zonder foto-uitsnede-risico
    const og = sl[0] || output.vierkant;
    if (og) await zet('og', 'og', { ...og, variant: og.variant === 'kaart' ? 'donker' : og.variant, tekst: pagina.og_beschrijving || og.tekst }, { soort: 'og', handle: 'training.deforexopleiding.nl' });
    return uit;
  }

  // ── Captions per kanaal (spiegel van api/_lib/contentmachine-social.js; de test houdt ze gelijk) ──
  const TRAINING_ORIGIN = 'https://training.deforexopleiding.nl';
  const SRC = { story: 'ig-story', post: 'ig-bio', linkedin: 'linkedin', vierkant: 'ig-bio' };
  function kanaalLink(slug, kanaal) {
    const src = SRC[kanaal] || kanaal;
    const q = new URLSearchParams({ src, utm_source: kanaal === 'linkedin' ? 'linkedin' : 'instagram', utm_medium: 'social', utm_campaign: `drop-${slug}` });
    return `${TRAINING_ORIGIN}/${slug}?${q.toString()}`;
  }
  const tags = (l) => (Array.isArray(l) ? l : []).map((h) => String(h).trim()).filter(Boolean).map((h) => (h.startsWith('#') ? h : '#' + h.replace(/\s+/g, '')));
  function captions(output, slug) {
    const p = (output && output.post) || {};
    const l = (output && output.linkedin) || {};
    const st = Array.isArray(output && output.stories) ? output.stories : [];
    const cta = st.find((x) => x && x.rol === 'cta');
    return {
      instagram_post: [String(p.caption || '').trim(), '', '👉 De volledige weekeditie: link in bio', '', tags(p.hashtags).join(' ')].join('\n').trim(),
      instagram_bio_link: kanaalLink(slug, 'post'),
      instagram_story_link: kanaalLink(slug, 'story'),
      instagram_story_sticker: (cta && cta.sticker_tekst) || 'Lees de weekeditie',
      linkedin: [String(l.tekst || '').trim(), '', `👉 ${kanaalLink(slug, 'linkedin')}`, '', tags(l.hashtags).slice(0, 3).join(' ')].join('\n').trim(),
    };
  }

  // ── Werkblad: editors en "Klaar om te posten" (gebruikt de hulpstukken van het werkblad) ──
  const H = () => window.__cmWbHulp;
  const ROL = { hook: 'Hook', nugget: 'Nugget', bewijs: 'Bewijs', cta: 'Naar de weekeditie' };
  const VLABEL = { foto: 'Foto (masterclass)', donker: 'Donker', licht: 'Licht', data: 'Data (groot getal)', kaart: 'Kaart (blok van de pagina)' };

  function beeldEditor(pad, spec) {
    const h = H(); const b = spec || {};
    const opties = VARIANTEN.map((v) => `<option value="${v}" ${b.variant === v ? 'selected' : ''}>${h.esc(VLABEL[v])}</option>`).join('');
    let x = `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">Variant</span><select class="ib-input cm-mini" onchange="__cmS2Variant('${pad}',this.value)">${opties}</select></label>`
      + h.veld(`${pad}.eyebrow`, 'Eyebrow (klein label)') + h.veld(`${pad}.titel`, 'Kop', { hint: '**…** wordt goud' }) + h.veld(`${pad}.tekst`, 'Subtekst', { lang: true, rijen: 2 });
    if (b.variant === 'foto') x += h.beeldVeld(`${pad}.beeld_asset_id`, 'Foto (masterclass/team)');
    if (b.variant === 'data') {
      const g = b.getal || {};
      x += `<div style="display:grid;grid-template-columns:1fr 70px 70px 70px;gap:6px">
        <label class="tk-field"><span class="tk-field-l">Getal</span><input class="ib-input cm-mini" type="number" step="any" value="${h.esc(g.waarde == null ? '' : g.waarde)}" oninput="__cmWbVeld('${pad}.getal.waarde',this.value===''?null:Number(this.value))"></label>
        <label class="tk-field"><span class="tk-field-l">Voor</span><input class="ib-input cm-mini" value="${h.esc(g.prefix || '')}" oninput="__cmWbVeld('${pad}.getal.prefix',this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Na</span><input class="ib-input cm-mini" value="${h.esc(g.suffix || '')}" oninput="__cmWbVeld('${pad}.getal.suffix',this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Decimalen</span><input class="ib-input cm-mini" type="number" min="0" max="2" value="${h.esc(g.decimalen == null ? '' : g.decimalen)}" oninput="__cmWbVeld('${pad}.getal.decimalen',this.value===''?null:Number(this.value))"></label></div>`
        + h.veld(`${pad}.getal.label`, 'Bij het getal') + '<div style="font-size:11px;color:var(--text-3);margin:-4px 0 8px">Enkel een cijfer uit de feitenbank of de invoer (anders blokkeert goedkeuren).</div>';
    }
    if (b.variant === 'kaart') {
      const bl = ((h.haal('pagina') || {}).blokken || []);
      x += `<label class="tk-field" style="margin-bottom:8px"><span class="tk-field-l">Blok van de pagina</span><select class="ib-input cm-mini" onchange="__cmWbVeld('${pad}.blok_index',Number(this.value))">${bl.map((k, i) => (k && k.type !== 'cadeau' ? `<option value="${i}" ${b.blok_index === i ? 'selected' : ''}>${i + 1}. ${h.esc(k.type)}</option>` : '')).join('')}</select></label>`;
    }
    return x;
  }
  window.__cmS2Variant = (pad, v) => {
    const h = H(); const b = h.haal(pad) || {};
    b.variant = v;
    if (v === 'data' && !b.getal) b.getal = { waarde: null, label: '' };
    if (v === 'kaart' && !Number.isInteger(b.blok_index)) { const bl = ((h.haal('pagina') || {}).blokken || []); const i = bl.findIndex((k) => k && (window.__cmBlokFrame || {}).INTERACTIEF && window.__cmBlokFrame.INTERACTIEF.includes(k.type)); b.blok_index = i >= 0 ? i : 1; }
    h.zetPad(pad, b); h.markeer(); h.rerender();
  };

  function editor(tab) {
    const h = H();
    if (tab === 'stories') {
      const st = h.haal('stories') || [];
      return st.map((x, i) => h.groep(`Story ${i + 1} · ${ROL[x.rol] || x.rol}`, beeldEditor(`stories.${i}`, x)
        + (x.rol === 'cta' ? h.veld(`stories.${i}.sticker_tekst`, 'Tekst op de linksticker') : ''))).join('');
    }
    if (tab === 'post') {
      const p = h.haal('post') || {};
      return (p.slides || []).map((x, i) => h.groep(`Slide ${i + 1} / ${p.slides.length}`, beeldEditor(`post.slides.${i}`, x))).join('')
        + h.groep('Caption', h.veld('post.caption', 'Caption (zonder link: "link in bio" komt er automatisch bij)', { lang: true, rijen: 8 })
          + `<label class="tk-field"><span class="tk-field-l">Hashtags (max 5, komma-gescheiden)</span><input class="ib-input cm-mini" value="${h.esc((p.hashtags || []).join(', '))}" oninput="__cmWbLijst('post.hashtags',this.value)"></label>`)
        + h.groep('Vierkant 1080×1080', beeldEditor('vierkant', h.haal('vierkant')));
    }
    const l = h.haal('linkedin') || {};
    return h.groep('LinkedIn-post', h.veld('linkedin.tekst', 'Tekst (hook, 3-5 korte alinea\'s; geen link of hashtags: die komen er automatisch bij)', { lang: true, rijen: 14 })
      + `<label class="tk-field"><span class="tk-field-l">Hashtags (max 3)</span><input class="ib-input cm-mini" value="${h.esc((l.hashtags || []).join(', '))}" oninput="__cmWbLijst('linkedin.hashtags',this.value)"></label>`)
      + h.groep('LinkedIn-beeld 1080×1350', beeldEditor('linkedin.beeld', l.beeld));
  }

  /** "Klaar om te posten": per kanaal de tekst en de link met kopieerknoppen. */
  function klaarOmTePosten(tab, slug) {
    const h = H(); const c = captions((window.__cmWb && window.__cmWb.output) || {}, slug);
    const blok = (titel, tekst, knop) => `<div style="background:var(--surface-2);border-radius:10px;padding:10px;margin-top:8px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b style="font-size:12px">${h.esc(titel)}</b>
      <a href="javascript:void(0)" style="font-size:12px" onclick="__cmWbKopieerDeel(${h.esc(JSON.stringify(tekst))})">${h.esc(knop || 'kopieer')}</a></div>
      <div style="font-size:12.5px;white-space:pre-wrap;margin-top:4px;word-break:break-word">${h.esc(tekst)}</div></div>`;
    const kop = '<div style="font-weight:700;font-size:13px;margin-top:12px">Klaar om te posten</div>';
    if (tab === 'stories') return kop + blok('Link voor de linksticker', c.instagram_story_link, 'kopieer link') + blok('Tekst op de sticker', c.instagram_story_sticker);
    if (tab === 'post') return kop + blok('Instagram-caption', c.instagram_post, 'kopieer caption') + blok('Link in bio (deze week)', c.instagram_bio_link, 'kopieer link');
    return kop + blok('LinkedIn-post (met link)', c.linkedin, 'kopieer post');
  }

  function voorbeeld(tab, slug) {
    const paneel = typeof window.__cmSocialPaneel === 'function' ? window.__cmSocialPaneel(tab) : '';
    return paneel + klaarOmTePosten(tab, slug);
  }

  window.__cmSocial2 = { renderAlles, tekenBeeld, FORMATEN, isV2, VARIANTEN, captions, kanaalLink, editor, voorbeeld };
})();
