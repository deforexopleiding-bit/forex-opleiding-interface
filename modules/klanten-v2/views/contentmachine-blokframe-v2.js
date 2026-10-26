// modules/klanten-v2/views/contentmachine-blokframe-v2.js
//
// Contentmachine 2.0 — een stilstaand "frame" van een blok van de Weekeditie, getekend
// op canvas met dezelfde data als de pagina (weekeditie-chart-v2.js = de chartmotor van
// de website). Gebruikt voor:
//   - het beeld in de nieuwsbrief (1200×750 PNG → Storage drops/<slug>/social/nieuwsbrief.png);
//   - de UI/chart-kaart-variant van de social-beelden (fase 4).
// Het frame stopt altijd vóór de onthulling (open lus: het antwoord staat op de pagina).
//
//   window.__cmBlokFrame = { kiesBlok, tekenKaart, renderMail, MAIL_W, MAIL_H }
(function () {
  'use strict';
  const K = () => window.__cmCanvas;
  const CH = () => window.__weChart;
  const MAIL_W = 1200, MAIL_H = 750;

  const INTERACTIEF = ['replay-sweep-bos', 'fib-animatie', 'quiz', 'rr-sliders', 'funded-calculator', 'trechter'];
  const STANDAARD = {
    'replay-sweep-bos': ['Speel het zelf af', 'Sweep of break? **Jij beslist.**', '▶  Speel af in de weekeditie'],
    'fib-animatie': ['Meten, niet gokken', 'De fib die **alles** ordent', 'Tik op een niveau in de weekeditie  →'],
    quiz: ['Wat zou jij doen?', '', 'Kies je antwoord in de weekeditie  →'],
    'rr-sliders': ['Reken zelf mee', 'Twee knoppen **bepalen alles**', 'Schuif zelf in de weekeditie  →'],
    'funded-calculator': ['Zelfde percentage, ander kapitaal', 'Wat je rendement **waard is**', 'Reken het uit in de weekeditie  →'],
    trechter: ['De DFO-volgorde', 'Van de grote lijn **tot de entry**', 'Tik door in de weekeditie  →'],
    'trade-ontleed': ['De trade ontleed', 'Eén trade, **stap voor stap**', 'Lees de volledige trade  →'],
    'payout-muur': ['Het bewijs', 'Echte payouts, **met toestemming**', 'Bekijk de payouts  →'],
    data: ['Data, geen screenshots', 'Wat de **cijfers** zeggen', 'Lees de weekeditie  →'],
    tip: ['Tip van de week', 'Eén tip. **Eén reden.**', 'Waarom? Lees het in de weekeditie  →'],
    'mythe-feit': ['Mythe of feit', 'Wat je overal hoort, **en hoe het zit**', 'Hoe het zit, lees je in de weekeditie  →'],
    vooruitblik: ['Volgende week', 'Op onze **watchlist**', 'Lees de scenario\'s  →'],
  };

  /** Welk blok levert het beeld: de keuze van de schrijver, anders het eerste interactieve, anders de hero. */
  function kiesBlok(pagina, voorkeur) {
    const bl = (pagina && pagina.blokken) || [];
    if (Number.isInteger(voorkeur) && bl[voorkeur] && bl[voorkeur].type !== 'cadeau') return { blok: bl[voorkeur], index: voorkeur };
    const i = bl.findIndex((b) => b && INTERACTIEF.includes(b.type));
    if (i >= 0) return { blok: bl[i], index: i };
    return { blok: bl[0] || null, index: 0 };
  }

  // ── chart op canvas (zelfde geometrie als components/weekeditie/basis.tsx) ──
  function schaal({ x, y, w, h, van, tot, mn, mx, padL = 14, padR = 14, padT = 18, padB = 18 }) {
    const n = Math.max(1, tot - van + 1);
    const cw = (w - padL - padR) / n;
    return { x: (i) => x + padL + (i - van + 0.5) * cw, y: (p) => y + padT + ((mx - p) / (mx - mn || 1)) * (h - padT - padB), cw };
  }
  function kaarsen(ctx, D, van, tot, s, { licht = false, nadruk } = {}) {
    const bw = Math.max(2, s.cw * 0.62);
    for (let i = Math.max(0, van); i <= Math.min(D.length - 1, tot); i++) {
      const k = D[i]; const op = k.c >= k.o; const x = s.x(i);
      ctx.strokeStyle = licht ? '#1d3a4f' : '#8FA7B5'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(x, s.y(k.h)); ctx.lineTo(x, s.y(k.l)); ctx.stroke();
      const yT = s.y(Math.max(k.o, k.c)), yB = s.y(Math.min(k.o, k.c));
      ctx.fillStyle = op ? (licht ? '#FFFFFF' : '#E6ECF0') : (licht ? '#1d3a4f' : '#45627a');
      ctx.fillRect(x - bw / 2, yT, bw, Math.max(1.5, yB - yT));
      if (op) { ctx.strokeStyle = licht ? '#1d3a4f' : '#8FA7B5'; ctx.lineWidth = 1; ctx.strokeRect(x - bw / 2, yT, bw, Math.max(1.5, yB - yT)); }
      if (i === nadruk) { ctx.strokeStyle = '#D0A050'; ctx.lineWidth = 3; ctx.strokeRect(x - bw / 2 - 2, yT - 2, bw + 4, Math.max(1.5, yB - yT) + 4); }
    }
  }
  function chip(ctx, x, y, t, { kleur = 'rgba(11,30,42,.9)', anker = 'start', px = 15 } = {}) {
    const c = K(); ctx.save();
    ctx.font = c.font(800, px); c.spatie(ctx, px * 0.06);
    const w = ctx.measureText(t).width + px * 1.3; const h = px * 1.75;
    const x0 = anker === 'end' ? x - w : anker === 'center' ? x - w / 2 : x;
    c.rondRect(ctx, x0, y - h / 2, w, h, px * 0.45); ctx.fillStyle = kleur; ctx.fill();
    ctx.fillStyle = '#F2F5F7'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(t, x0 + w / 2, y + 1);
    ctx.restore();
  }
  function stippel(ctx, x0, x1, y, kleur = '#8FA7B5') {
    ctx.save(); ctx.setLineDash([10, 8]); ctx.strokeStyle = kleur; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.restore();
  }
  function knop(ctx, x, y, w, h, t, { vol = true, px = 20 } = {}) {
    const c = K(); ctx.save();
    c.rondRect(ctx, x, y, w, h, h * 0.32);
    if (vol) { ctx.fillStyle = c.verloop(ctx, x, y, x, y + h, [[0, '#E2B866'], [0.45, '#D0A050'], [1, '#B88941']]); ctx.fill(); }
    else { ctx.strokeStyle = 'rgba(217,227,232,.35)'; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.font = c.font(800, px); ctx.fillStyle = vol ? '#0B1E2A' : '#F2F5F7'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x + w / 2, y + h / 2 + 1); ctx.restore();
  }

  // ── per bloktype de inhoud van de kaart ───────────────────────────────────
  const TEKEN = {
    'replay-sweep-bos'(ctx, b, r) {
      const f = CH().fragment(b.props.richting, b.props.scenario);
      const van = f.niveauKaars - 8;
      const bb = CH().bereik(f.set.D, van, f.tot + 2, [f.niveau]);
      const s = schaal({ x: r.x, y: r.y, w: r.w, h: r.h * 0.7, van, tot: f.tot + 3, mn: bb.mn, mx: bb.mx, padT: 30 });
      const yN = s.y(f.niveau);
      stippel(ctx, s.x(f.niveauKaars), r.x + r.w - 14, yN);
      ctx.fillStyle = '#D0A050'; ctx.beginPath(); ctx.arc(s.x(f.niveauKaars), yN, 6, 0, Math.PI * 2); ctx.fill();
      kaarsen(ctx, f.set.D, van, f.kaars, s, { licht: r.licht, nadruk: f.kaars });
      chip(ctx, s.x(f.niveauKaars) - 8, f.kant === 'lo' ? yN + 26 : yN - 26, f.kant === 'lo' ? 'NIVEAU · LOW' : 'NIVEAU · HIGH');
      // de vraag (pauze) — open lus
      const py = r.y + r.h * 0.72, ph = r.h * 0.26;
      const c = K(); ctx.save(); c.rondRect(ctx, r.x + 14, py, r.w - 28, ph, 18);
      ctx.fillStyle = 'rgba(11,30,42,.94)'; ctx.fill(); ctx.strokeStyle = 'rgba(208,160,80,.6)'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
      ctx.font = c.font(800, 24); ctx.fillStyle = '#F2F5F7'; ctx.textBaseline = 'top';
      ctx.fillText(b.props.vraag || 'Prijs gaat voorbij het niveau. Sweep of break of structure?', r.x + 36, py + 20);
      const bw = (r.w - 28 - 22 * 3) / 2;
      knop(ctx, r.x + 36, py + ph - 70, bw, 52, 'Sweep');
      knop(ctx, r.x + 36 + bw + 22, py + ph - 70, bw, 52, 'Break of structure');
    },
    'fib-animatie'(ctx, b, r) {
      const set = CH().hoofdSet(b.props.richting);
      const van = set.K.swing - 6, tot = set.K.ret + 4;
      const bb = CH().bereik(set.D, van, tot, [set.L.one, set.L.zero, set.L.l71, set.L.ext], 0.04);
      const s = schaal({ x: r.x, y: r.y, w: r.w, h: r.h, van, tot: tot + 9, mn: bb.mn, mx: bb.mx, padT: 26, padB: 22 });
      kaarsen(ctx, set.D, van, tot, s, { licht: r.licht });
      ctx.strokeStyle = '#D0A050'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(s.x(set.K.sweep), s.y(set.L.one)); ctx.lineTo(s.x(set.K.zeroI), s.y(set.L.zero)); ctx.stroke();
      const lv = [[set.L.ext, '−27 · target', '#2f9a76'], [set.L.zero, '0 · risk free', '#5f7584'], [set.L.l71, '71 · entry', '#B88941'], [set.L.one, '1 · stop', '#c2483d']];
      const x0 = s.x(set.K.sweep) - 6, x1 = r.x + r.w - 14;
      for (const [p, t, k] of lv) {
        ctx.strokeStyle = k; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(x0, s.y(p)); ctx.lineTo(x1, s.y(p)); ctx.stroke();
        chip(ctx, x1 - 4, s.y(p) - 18, t, { kleur: k, anker: 'end' });
      }
    },
    quiz(ctx, b, r) {
      const c = K();
      const metChart = !!b.props.chart;
      const optX = metChart ? r.x + r.w * 0.56 : r.x + 24, optW = metChart ? r.w * 0.44 - 24 : r.w - 48;
      if (metChart) {
        const ch = b.props.chart;
        if (ch.soort === 'sweep' || ch.soort === 'bos') {
          const f = CH().fragment(ch.richting, ch.soort);
          const van = f.niveauKaars - 4;
          const bb = CH().bereik(f.set.D, van, f.tot + 2, [f.niveau]);
          const s = schaal({ x: r.x, y: r.y, w: r.w * 0.55, h: r.h, van, tot: f.tot + 3, mn: bb.mn, mx: bb.mx, padT: 30 });
          stippel(ctx, s.x(f.niveauKaars), r.x + r.w * 0.55 - 10, s.y(f.niveau));
          kaarsen(ctx, f.set.D, van, f.kaars, s, { licht: r.licht, nadruk: f.kaars });
        } else {
          const set = CH().hoofdSet(ch.richting);
          const van = set.K.swing - 6, tot = set.K.zeroI + 6;
          const bb = CH().bereik(set.D, van, tot, [set.L.one, set.L.ext], 0.04);
          const s = schaal({ x: r.x, y: r.y, w: r.w * 0.55, h: r.h, van, tot: tot + 6, mn: bb.mn, mx: bb.mx });
          kaarsen(ctx, set.D, van, tot, s, { licht: r.licht });
        }
      }
      const opties = b.props.opties || [];
      const oh = Math.min(96, (r.h - 40 - (opties.length - 1) * 14) / Math.max(1, opties.length));
      opties.forEach((o, i) => {
        const y = r.y + 24 + i * (oh + 14);
        c.rondRect(ctx, optX, y, optW, oh, 16); ctx.fillStyle = r.licht ? '#F4F6F8' : 'rgba(255,255,255,.05)'; ctx.fill();
        ctx.strokeStyle = r.licht ? 'rgba(19,41,58,.12)' : 'rgba(217,227,232,.16)'; ctx.lineWidth = 2; ctx.stroke();
        c.rondRect(ctx, optX + 16, y + oh / 2 - 22, 44, 44, 11); ctx.fillStyle = 'rgba(208,160,80,.2)'; ctx.fill();
        ctx.font = c.font(800, 22); ctx.fillStyle = '#D0A050'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String.fromCharCode(65 + i), optX + 38, y + oh / 2 + 1); ctx.textAlign = 'left';
        c.tekst(ctx, o, { x: optX + 76, y: y + oh / 2 - 14 - (o.length > 34 ? 13 : 0), maxW: optW - 96, px: 22, w: 700, kleur: r.licht ? '#13293A' : '#F2F5F7', maxRegels: 2, minPx: 18, lh: 1.25 });
      });
    },
    'rr-sliders'(ctx, b, r) {
      const c = K(); const wr = b.props.start_winrate, rr = b.props.start_rr;
      const res = CH().rOver100(wr, rr);
      const lx = r.x + 30, lw = r.w * 0.42;
      const slider = (y, label, waarde, p) => {
        ctx.font = c.font(700, 22); ctx.fillStyle = r.licht ? '#41596C' : '#C9D6DE'; ctx.textBaseline = 'alphabetic'; ctx.fillText(label, lx, y);
        ctx.font = c.font(800, 26); ctx.fillStyle = r.licht ? '#13293A' : '#F2F5F7'; ctx.textAlign = 'right'; ctx.fillText(waarde, lx + lw, y); ctx.textAlign = 'left';
        c.rondRect(ctx, lx, y + 22, lw, 10, 5); ctx.fillStyle = 'rgba(208,160,80,.25)'; ctx.fill();
        c.rondRect(ctx, lx, y + 22, lw * p, 10, 5); ctx.fillStyle = '#D0A050'; ctx.fill();
        ctx.beginPath(); ctx.arc(lx + lw * p, y + 27, 17, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#D0A050'; ctx.lineWidth = 5; ctx.stroke();
      };
      slider(r.y + 70, 'Winrate', `${String(wr).replace('.', ',')}%`, (wr - 10) / 70);
      slider(r.y + 180, 'Gemiddelde winnende trade', `${rr.toFixed(2).replace('.', ',')}R`, (rr - 0.5) / 4.5);
      const rx = r.x + r.w * 0.52;
      ctx.font = c.font(800, 104, 'kop'); c.spatie(ctx, -4); ctx.fillStyle = res >= 0 ? '#3FC79A' : '#E5675C'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${res >= 0 ? '+' : '−'}${Math.abs(Math.round(res))}R`, rx, r.y + 130); c.spatie(ctx, 0);
      ctx.font = c.font(600, 22); ctx.fillStyle = r.licht ? '#41596C' : '#C9D6DE'; ctx.fillText('over 100 trades, bij 1% risico', rx, r.y + 172);
      const n = Math.round(wr); const t = 20, g = 5, tw = (r.w * 0.44 - (t - 1) * g) / t;
      const rnd = CH().rng(424242); const a = Array.from({ length: 100 }, (_, i) => i < n);
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      a.forEach((w, i) => { ctx.fillStyle = w ? '#D0A050' : (r.licht ? 'rgba(19,41,58,.1)' : 'rgba(217,227,232,.12)'); ctx.fillRect(rx + (i % t) * (tw + g), r.y + 210 + Math.floor(i / t) * (tw + g), tw, tw); });
    },
    'funded-calculator'(ctx, b, r) {
      const c = K(); const acc = b.props.start_account, pct = b.props.start_rendement;
      const maand = CH().fundedMaand(acc, pct, 0.8);
      const usd = (v) => '$' + Math.round(v).toLocaleString('nl-NL');
      const sizes = CH().ACCOUNTGROOTTES; let x = r.x + 30;
      ctx.font = c.font(800, 22);
      sizes.forEach((s) => {
        const t = s >= 1e6 ? '1M' : (s / 1000) + 'K'; const w = ctx.measureText(t).width + 34;
        c.rondRect(ctx, x, r.y + 30, w, 46, 23); ctx.fillStyle = s === acc ? '#D0A050' : 'transparent'; ctx.fill();
        ctx.strokeStyle = s === acc ? '#D0A050' : 'rgba(217,227,232,.25)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = s === acc ? '#0B1E2A' : (r.licht ? '#41596C' : '#C9D6DE'); ctx.textBaseline = 'middle'; ctx.fillText(t, x + 17, r.y + 54); x += w + 12;
      });
      ctx.textBaseline = 'alphabetic'; ctx.font = c.font(700, 22); ctx.fillStyle = r.licht ? '#41596C' : '#C9D6DE';
      ctx.fillText(`Rendement ${String(pct).replace('.', ',')}% per maand · split 80%`, r.x + 30, r.y + 130);
      ctx.font = c.font(800, 96, 'kop'); c.spatie(ctx, -3); ctx.fillStyle = '#3FC79A'; ctx.fillText(usd(maand), r.x + 30, r.y + 240); c.spatie(ctx, 0);
      ctx.font = c.font(600, 22); ctx.fillStyle = r.licht ? '#41596C' : '#C9D6DE'; ctx.fillText('jouw deel per maand · rekenvoorbeeld, geen belofte', r.x + 30, r.y + 280);
      const max = CH().fundedMaand(sizes[sizes.length - 1], pct, 0.8);
      sizes.forEach((s, i) => {
        const y = r.y + 316 + i * 30; const w = (r.w - 260) * (CH().fundedMaand(s, pct, 0.8) / max);
        ctx.font = c.font(700, 18); ctx.fillStyle = r.licht ? '#41596C' : '#8FA7B5'; ctx.fillText((s / 1000) + 'K', r.x + 30, y + 16);
        c.rondRect(ctx, r.x + 90, y + 4, r.w - 260, 14, 7); ctx.fillStyle = r.licht ? 'rgba(19,41,58,.08)' : 'rgba(217,227,232,.1)'; ctx.fill();
        c.rondRect(ctx, r.x + 90, y + 4, Math.max(14, w), 14, 7); ctx.fillStyle = s === acc ? '#D0A050' : 'rgba(208,160,80,.45)'; ctx.fill();
      });
    },
    trechter(ctx, b, r) {
      const c = K(); const st = b.props.stappen || [];
      const n = st.length; const h = Math.min(54, (r.h - 40) / n - 8);
      st.forEach((x, i) => {
        const w = (r.w * 0.5) * (1 - (i / Math.max(1, n - 1)) * 0.46);
        const x0 = r.x + 30 + (r.w * 0.5 - w) / 2, y = r.y + 24 + i * (h + 8);
        c.rondRect(ctx, x0, y, w, h, 12); ctx.fillStyle = i === 0 ? '#D0A050' : (r.licht ? '#F4F6F8' : 'rgba(255,255,255,.05)'); ctx.fill();
        ctx.strokeStyle = i === 0 ? '#D0A050' : 'rgba(217,227,232,.16)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.font = c.font(800, 20); ctx.fillStyle = i === 0 ? '#0B1E2A' : (r.licht ? '#41596C' : '#C9D6DE'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${String(i + 1).padStart(2, '0')}  ${x.label}`, x0 + w / 2, y + h / 2 + 1); ctx.textAlign = 'left';
      });
      const kx = r.x + r.w * 0.58, kw = r.w * 0.42 - 30;
      ctx.font = c.font(800, 18); c.spatie(ctx, 3); ctx.fillStyle = '#D0A050'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`01 / ${String(n).padStart(2, '0')} · ${String(st[0] ? st[0].label : '').toUpperCase()}`, kx, r.y + 70); c.spatie(ctx, 0);
      const y = c.tekst(ctx, st[0] ? st[0].titel : '', { x: kx, y: r.y + 90, maxW: kw, px: 40, w: 800, soort: 'kop', kleur: r.licht ? '#13293A' : '#F2F5F7', maxRegels: 2, minPx: 30 });
      c.tekst(ctx, st[0] ? st[0].tekst : '', { x: kx, y: y + 10, maxW: kw, px: 22, w: 500, kleur: r.licht ? '#41596C' : '#C9D6DE', maxRegels: 5, lh: 1.45 });
    },
    data(ctx, b, r) {
      const c = K(); const cs = b.props.cijfers || []; const n = cs.length; const kw = (r.w - 60) / n;
      cs.forEach((x, i) => {
        const cx = r.x + 30 + i * kw;
        const getal = `${x.prefix || ''}${Number(x.waarde).toLocaleString('nl-NL', { minimumFractionDigits: x.decimalen || 0, maximumFractionDigits: x.decimalen || 0 })}${x.suffix || ''}`;
        ctx.font = c.font(800, n === 1 ? 180 : 92, 'kop'); c.spatie(ctx, n === 1 ? -9 : -4); ctx.fillStyle = r.licht ? '#13293A' : '#F2F5F7'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(getal, cx, r.y + (n === 1 ? 210 : 150)); c.spatie(ctx, 0);
        c.tekst(ctx, x.label, { x: cx, y: r.y + (n === 1 ? 240 : 180), maxW: kw - 30, px: n === 1 ? 32 : 24, w: 700, kleur: r.licht ? '#13293A' : '#F2F5F7', maxRegels: 2 });
        if (x.context) c.tekst(ctx, x.context, { x: cx, y: r.y + (n === 1 ? 300 : 250), maxW: kw - 30, px: 20, w: 500, kleur: r.licht ? '#41596C' : '#C9D6DE', maxRegels: 3 });
      });
    },
    tip(ctx, b, r) {
      const c = K();
      ctx.font = c.font(800, 18); c.spatie(ctx, 3.5); ctx.fillStyle = '#D0A050'; ctx.textBaseline = 'alphabetic'; ctx.fillText('DE TIP', r.x + 40, r.y + 60); c.spatie(ctx, 0);
      c.tekst(ctx, b.props.voorkant, { x: r.x + 40, y: r.y + 84, maxW: r.w - 80, px: 62, w: 800, soort: 'kop', kleur: r.licht ? '#13293A' : '#F2F5F7', maxRegels: 3, minPx: 40, accent: r.licht ? 'marker' : 'kleur' });
      knop(ctx, r.x + 40, r.y + r.h - 96, 220, 60, 'Waarom?  →');
    },
    'mythe-feit'(ctx, b, r) {
      const c = K(); const it = (b.props.items || [])[0] || {};
      ctx.font = c.font(800, 18); c.spatie(ctx, 3.5); ctx.fillStyle = '#D0A050'; ctx.textBaseline = 'alphabetic'; ctx.fillText('WAT JE OVERAL HOORT', r.x + 40, r.y + 60); c.spatie(ctx, 0);
      c.tekst(ctx, `“${it.mythe || ''}”`, { x: r.x + 40, y: r.y + 84, maxW: r.w - 80, px: 50, w: 800, soort: 'kop', kleur: r.licht ? '#13293A' : '#F2F5F7', maxRegels: 4, minPx: 34 });
      knop(ctx, r.x + 40, r.y + r.h - 96, 240, 60, 'Klopt dat?  →');
    },
    vooruitblik(ctx, b, r) {
      const c = K(); const ps = (b.props.paren || []).slice(0, 4); const kw = (r.w - 60 - 16) / 2, kh = (r.h - 60 - 16) / 2;
      ps.forEach((p, i) => {
        const x = r.x + 30 + (i % 2) * (kw + 16), y = r.y + 30 + Math.floor(i / 2) * (kh + 16);
        c.rondRect(ctx, x, y, kw, kh, 18); ctx.fillStyle = r.licht ? '#F4F6F8' : 'rgba(255,255,255,.05)'; ctx.fill();
        ctx.font = c.font(800, 30, 'kop'); ctx.fillStyle = r.licht ? '#13293A' : '#F2F5F7'; ctx.textBaseline = 'alphabetic'; ctx.fillText(p.paar, x + 22, y + 48);
        const kl = p.bias === 'bullish' ? '#3FC79A' : p.bias === 'bearish' ? '#E5675C' : '#8FA7B5';
        ctx.font = c.font(800, 15); c.spatie(ctx, 2); const bw = ctx.measureText(p.bias.toUpperCase()).width + 24;
        c.rondRect(ctx, x + kw - bw - 18, y + 24, bw, 30, 15); ctx.fillStyle = kl + '30'; ctx.fill(); ctx.fillStyle = kl; ctx.textBaseline = 'middle'; ctx.fillText(p.bias.toUpperCase(), x + kw - bw - 6, y + 40); c.spatie(ctx, 0);
        c.tekst(ctx, p.zin, { x: x + 22, y: y + 70, maxW: kw - 44, px: 19, w: 500, kleur: r.licht ? '#41596C' : '#C9D6DE', maxRegels: 3 });
      });
    },
  };

  function heroKaart(ctx, b, r) {
    const c = K(); const p = (b && b.props) || {};
    c.tekst(ctx, p.titel || 'De Weekeditie', { x: r.x + 40, y: r.y + 50, maxW: r.w - 80, px: 64, w: 800, soort: 'kop', kleur: r.licht ? '#13293A' : '#F2F5F7', maxRegels: 3, minPx: 44, accent: r.licht ? 'marker' : 'kleur' });
  }

  /**
   * Teken de kaart van een blok in rechthoek r = { x, y, w, h, licht }.
   * opties.payouts = geladen Image-objecten voor de payout-muur.
   */
  function tekenKaart(ctx, blok, r, opties = {}) {
    const c = K();
    c.kaart(ctx, r.x, r.y, r.w, r.h, { vul: r.licht ? '#FFFFFF' : '#0d2230', rand: r.licht ? 'rgba(19,41,58,.08)' : 'rgba(217,227,232,.12)', schaduw: r.licht ? 'rgba(19,41,58,.28)' : 'rgba(0,0,0,.5)' });
    ctx.save(); c.rondRect(ctx, r.x, r.y, r.w, r.h, 28); ctx.clip();
    if (blok && blok.type === 'payout-muur') {
      const imgs = opties.payouts || []; const items = blok.props.payouts || [];
      const n = Math.min(3, items.length); const kw = (r.w - 60 - (n - 1) * 16) / Math.max(1, n);
      items.slice(0, n).forEach((x, i) => {
        const kx = r.x + 30 + i * (kw + 16), ky = r.y + 30, kh = r.h - 60;
        c.rondRect(ctx, kx, ky, kw, kh, 18); ctx.fillStyle = '#0a1822'; ctx.fill();
        ctx.save(); c.rondRect(ctx, kx, ky, kw, kh * 0.7, 18); ctx.clip(); c.cover(ctx, imgs[i], kx, ky, kw, kh * 0.7, { focusY: 0 }); ctx.restore();
        ctx.font = c.font(800, 40, 'kop'); ctx.fillStyle = '#F2F5F7'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(`${x.valuta}${Number(x.bedrag).toLocaleString('nl-NL')}`, kx + 20, ky + kh * 0.7 + 58);
        if (x.label) { ctx.font = c.font(600, 18); ctx.fillStyle = '#8FA7B5'; ctx.fillText(x.label, kx + 20, ky + kh * 0.7 + 88); }
      });
    } else if (blok && TEKEN[blok.type]) {
      TEKEN[blok.type](ctx, blok, { x: r.x, y: r.y, w: r.w, h: r.h, licht: r.licht });
    } else {
      heroKaart(ctx, blok, r);
    }
    ctx.restore();
  }

  /**
   * Het beeld voor de nieuwsbrief: eyebrow + kop + de kaart van het blok + een "speel af"-oproep.
   * → canvas (1200×750).
   */
  async function renderMail({ pagina, blokIndex, assets = {} }) {
    const c = K(); await c.laadAlles();
    const { blok } = kiesBlok(pagina, blokIndex);
    const licht = pagina && pagina.thema === 'licht';
    const cv = document.createElement('canvas'); cv.width = MAIL_W; cv.height = MAIL_H;
    const ctx = cv.getContext('2d');
    // achtergrond in het thema van de editie
    ctx.fillStyle = licht ? c.verloop(ctx, 0, 0, 0, MAIL_H, [[0, '#F7F8FA'], [1, '#EAEFF3']]) : c.verloop(ctx, 0, 0, MAIL_W * 0.3, MAIL_H, [[0, '#1b3245'], [0.65, '#0b1a24'], [1, '#0b1a24']]);
    ctx.fillRect(0, 0, MAIL_W, MAIL_H);
    const g = ctx.createRadialGradient(MAIL_W * 0.92, -40, 0, MAIL_W * 0.92, -40, 700);
    g.addColorStop(0, 'rgba(208,160,80,.18)'); g.addColorStop(1, 'rgba(208,160,80,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, MAIL_W, MAIL_H);
    const [eb, kop, oproep] = STANDAARD[blok && blok.type] || ['De Weekeditie', '', 'Lees de volledige weekeditie  →'];
    const p = (blok && blok.props) || {};
    c.eyebrow(ctx, p.eyebrow || eb, 56, 46, { px: 20, kleur: licht ? c.KLEUR.goudInkt : c.KLEUR.goud });
    const titel = p.titel || p.vraag || kop || 'De Weekeditie';
    const yNa = c.tekst(ctx, titel, { x: 56, y: 84, maxW: MAIL_W - 112, px: 52, w: 800, soort: 'kop', kleur: licht ? '#13293A' : '#F2F5F7', accent: licht ? 'marker' : 'kleur', maxRegels: 1, minPx: 34 });
    const ky = Math.max(166, yNa + 18);
    let payouts = [];
    if (blok && blok.type === 'payout-muur') payouts = await Promise.all((p.payouts || []).slice(0, 3).map((x) => c.laadBeeld(assets[x.asset_id] && assets[x.asset_id].publieke_url)));
    tekenKaart(ctx, blok, { x: 56, y: ky, w: MAIL_W - 112, h: MAIL_H - ky - 100, licht }, { payouts });
    // oproep + logo
    ctx.font = c.font(800, 24); ctx.fillStyle = licht ? c.KLEUR.goudInkt : c.KLEUR.goud; ctx.textBaseline = 'middle';
    ctx.fillText(oproep, 56, MAIL_H - 48);
    c.logo(ctx, MAIL_W - 56 - 112, MAIL_H - 76, 56, { wit: !licht });
    return cv;
  }

  window.__cmBlokFrame = { kiesBlok, tekenKaart, renderMail, MAIL_W, MAIL_H, INTERACTIEF };
})();
