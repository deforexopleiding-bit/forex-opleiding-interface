// modules/klanten-v2/views/weekeditie-chart-v2.js
//
// GEGENEREERD uit dfo-website lib/weekeditie-chart.ts (node:module stripTypeScriptTypes) —
// niet met de hand wijzigen. Zelfde candles, fib en rekenvoorbeelden als de Weekeditie op de
// website, zodat het blokframe in de nieuwsbrief en de social-kaarten exact de pagina tonen.
// tests/contentmachine-blokframe.test.js controleert een paar waarden tegen de website.
(function () {
  'use strict';
  // Chartdata voor de Weekeditie — geport uit The Lab (dfo-lms-prototype
  // public/lab-sim/index.html: rng, series, mkSet, setpiece A en de fragmenten
  // "sweep of break"). Puur: geen DOM, geen React, geen LMS-afhankelijkheden.
  //
  // Candles worden deterministisch gegenereerd uit ankerpunten + een seed, dus elke
  // render (server én browser) geeft exact dezelfde chart. Een short-scenario is
  // het spiegelbeeld van het long-scenario (prijs gespiegeld rond het midden).

  /** mulberry32 — zelfde PRNG als The Lab. */
  function rng(seed        ) {
    let s = seed;
    return function () {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Candles tussen ankers (smoothstep + ruis), ankers blijven het zuivere extreem. */
  function series(anch         , ovr                       , n        , seed        , noise        , dec = 5)          {
    const R = (x        ) => +x.toFixed(dec);
    const r = rng(seed);
    const d          = [];
    const base = (i        ) => {
      for (let k = 0; k < anch.length - 1; k++) {
        const a = anch[k], b = anch[k + 1];
        if (i >= a[0] && i <= b[0]) { const t = (i - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * (t * t * (3 - 2 * t)); }
      }
      return anch[anch.length - 1][1];
    };
    let prev = anch[0][1];
    for (let i = 0; i < n; i++) {
      const o = prev;
      let c = base(i) + (r() - 0.5) * noise;
      let h = Math.max(o, c) + r() * noise * 0.75, l = Math.min(o, c) - r() * noise * 0.75;
      const a = anch.find((x) => x[0] === i);
      if (a) { if (a[2] === 'hi') { h = a[1]; c = a[1] - r() * noise * 0.35; } else { l = a[1]; c = a[1] + r() * noise * 0.35; } }
      d.push({ o: R(o), h: R(h), l: R(l), c: R(c) });
      prev = c;
    }
    anch.forEach((a) => {
      for (let i = Math.max(0, a[0] - 3); i <= Math.min(n - 1, a[0] + 3); i++) {
        if (i === a[0] || anch.some((x) => x[0] === i) || ovr[i]) continue;
        const k = d[i], m = noise * 0.12;
        if (a[2] === 'hi' && k.h > a[1] - m) { k.h = a[1] - m; k.o = Math.min(k.o, k.h); k.c = Math.min(k.c, k.h); k.l = Math.min(k.l, k.h); }
        if (a[2] === 'lo' && k.l < a[1] + m) { k.l = a[1] + m; k.o = Math.max(k.o, k.l); k.c = Math.max(k.c, k.l); k.h = Math.max(k.h, k.l); }
        d[i] = { o: R(k.o), h: R(k.h), l: R(k.l), c: R(k.c) };
      }
    });
    Object.keys(ovr).forEach((k) => { d[+k] = ovr[+k]; });
    return d;
  }

  /** DFO-fib uit 1 (sweep-extreem = stop) en -27 (target): 0 = impulstop, 71 = entry. */
  function fibNiveaus(one        , ext        ) {
    const zero = (ext + 0.27 * one) / 1.27;
    const l71 = zero - 0.71 * (zero - one);
    return { one, zero, l71, ext };
  }

  // ── Setpiece A uit The Lab: AUDCHF H4 long (de sweep van 41, de BOS van 46) ──
  const A_ANKERS          = [[0, 0.5356, 'hi'], [6, 0.531, 'lo'], [12, 0.5335, 'hi'], [16, 0.532, 'lo'], [21, 0.5415, 'hi'], [25, 0.5392, 'lo'],
    [29, 0.5425, 'hi'], [34, 0.5368, 'lo'], [38, 0.5385, 'hi'], [41, 0.5343, 'lo'], [46, 0.5433, 'hi'], [52, 0.5378, 'lo'],
    [55, 0.5395, 'hi'], [61, 0.535, 'lo'], [68, 0.54784, 'hi'], [71, 0.5448, 'lo'], [73, 0.5462, 'hi'], [78, 0.5367, 'lo'],
    [84, 0.5452, 'hi'], [90, 0.5415, 'lo'], [95, 0.5448, 'hi'], [99, 0.5433, 'lo'], [103, 0.5505, 'hi'], [108, 0.5442, 'lo'],
    [112, 0.5462, 'hi'], [118, 0.5425, 'lo'], [124, 0.5452, 'hi'], [128, 0.5433, 'lo'], [134, 0.5462, 'hi'], [139, 0.5442, 'lo'],
    [145, 0.548, 'hi'], [149, 0.546, 'lo'], [155, 0.549, 'hi'], [159, 0.5468, 'lo'], [164, 0.55158, 'hi'], [170, 0.5465, 'lo']];
  const A_OVR                        = {
    61: { o: 0.5356, h: 0.536, l: 0.53401, c: 0.5352 }, 62: { o: 0.5379, h: 0.53802, l: 0.53495, c: 0.5353 },
    63: { o: 0.5354, h: 0.54, l: 0.535, c: 0.5398 }, 64: { o: 0.53985, h: 0.5429, l: 0.539, c: 0.5424 },
    65: { o: 0.5424, h: 0.5447, l: 0.5421, c: 0.544 },
  };
  let _A                  = null;
  function setA()           {
    if (_A) return _A;
    _A = {
      label: 'The Lab · H4', richting: 'long',
      D: series(A_ANKERS, A_OVR, 171, 90210, 0.00072),
      L: fibNiveaus(0.53401, 0.55158),
      K: { swing: 41, bLevel: 46, sweep: 61, ob: 62, bos: 65, zeroI: 68, ret: 78, tp: 164 },
    };
    return _A;
  }

  // ── 15M-impuls in de H4-zone (eigen ankers, zelfde motor) ────────────────────
  const M_ANKERS          = [[0, 0.5412, 'hi'], [6, 0.5392, 'lo'], [10, 0.5401, 'hi'], [16, 0.5381, 'lo'], [20, 0.539, 'hi'],
    [26, 0.53702, 'lo'], [33, 0.5402, 'hi'], [36, 0.5396, 'lo'], [40, 0.5414, 'hi'], [44, 0.54095, 'lo'], [48, 0.5419, 'hi'],
    [53, 0.5384, 'lo'], [60, 0.5412, 'hi'], [65, 0.5399, 'lo'], [74, 0.54362, 'hi'], [79, 0.5426, 'lo']];
  let _M                  = null;
  function setM()           {
    if (_M) return _M;
    const one = 0.53702, zero = 0.5419;
    const ext = zero + 0.27 * (zero - one);
    _M = {
      label: 'The Lab · 15M', richting: 'long',
      D: series(M_ANKERS, {}, 80, 31337, 0.00028),
      L: fibNiveaus(one, ext),
      K: { swing: 16, bLevel: 20, sweep: 26, ob: 26, bos: 33, zeroI: 48, ret: 53, tp: 74 },
    };
    return _M;
  }

  /** Spiegelbeeld (long → short): prijs rond het midden gespiegeld, high ↔ low. */
  function spiegel(s          )           {
    let mn = Infinity, mx = -Infinity;
    for (const k of s.D) { mn = Math.min(mn, k.l); mx = Math.max(mx, k.h); }
    const m = (p        ) => +(mn + mx - p).toFixed(6);
    return {
      ...s,
      richting: s.richting === 'long' ? 'short' : 'long',
      D: s.D.map((k) => ({ o: m(k.o), h: m(k.l), l: m(k.h), c: m(k.c) })),
      L: { one: m(s.L.one), zero: m(s.L.zero), l71: m(s.L.l71), ext: m(s.L.ext) },
    };
  }

  function hoofdSet(richting                  )           {
    return richting === 'long' ? setA() : spiegel(setA());
  }
  function ltfSet(richting                  )           {
    return richting === 'long' ? setM() : spiegel(setM());
  }

  /**
   * Fragment "sweep of break" (The Lab, FRAGMENTEN): het niveau, de kaars die er
   * voorbij gaat, en tot waar de onthulling loopt. Long: sweep van de low van 41
   * door kaars 61, BOS van de high van 46 door kaars 65.
   */

  function fragment(richting                  , scenario                 )           {
    const set = hoofdSet(richting);
    const sweep = scenario === 'sweep';
    // In het long-beeld: sweep = onder een low, bos = boven een high. Gespiegeld omgekeerd.
    const kantLong              = sweep ? 'lo' : 'hi';
    const kant              = richting === 'long' ? kantLong : (kantLong === 'lo' ? 'hi' : 'lo');
    const niveauKaars = sweep ? 41 : 46;
    const k = set.D[niveauKaars];
    return {
      set, niveauKaars, kant, niveau: kant === 'lo' ? k.l : k.h,
      kaars: sweep ? 61 : 65, tot: sweep ? 68 : 74, start: sweep ? 50 : 56, sweep,
    };
  }

  /** Prijsbereik van een reeks kaarsen (+ extra niveaus), met marge. */
  function bereik(D         , van        , tot        , extra           = [], marge = 0.06) {
    let mn = Infinity, mx = -Infinity;
    for (let i = Math.max(0, van); i <= Math.min(D.length - 1, tot); i++) { mn = Math.min(mn, D[i].l); mx = Math.max(mx, D[i].h); }
    for (const p of extra) { mn = Math.min(mn, p); mx = Math.max(mx, p); }
    const pad = (mx - mn) * marge || 0.0001;
    return { mn: mn - pad, mx: mx + pad };
  }

  /** Kleine, generieke impuls-chart (hero chart, quiz, trade-ontleed): deterministisch per seed. */
  function miniReeks(richting                  , seed = 7, n = 48)          {
    const ank          = [[0, 1.0, 'hi'], [8, 0.982, 'lo'], [14, 0.991, 'hi'], [21, 0.975, 'lo'], [32, 1.012, 'hi'], [38, 1.0, 'lo'], [n - 1, 1.03, 'hi']];
    const d = series(ank, {}, n, seed, 0.0042, 5);
    if (richting === 'long') return d;
    return spiegel({ label: '', richting: 'long', D: d, L: fibNiveaus(0.975, 1.03), K: { swing: 0, bLevel: 0, sweep: 0, ob: 0, bos: 0, zeroI: 0, ret: 0, tp: 0 } }).D;
  }

  /** Accountgroottes van de funded-calculator (salesdeck, zonder de 1M). */
  const ACCOUNTGROOTTES = [10000, 25000, 50000, 100000, 200000, 400000]         ;

  /** R-resultaat over 100 trades bij winrate (%) en gemiddelde winnende trade (R): masterclass deel 1. */
  function rOver100(winrate        , rr        )         {
    return winrate * rr - (100 - winrate);
  }
  /** Quittepunt in winrate-% bij een gegeven R. */
  function quitte(rr        )         {
    return 100 / (1 + rr);
  }
  /** Funded-rekenvoorbeeld (salesdeck): kapitaal × maandrendement × split. */
  function fundedMaand(account        , pctPerMaand        , split = 0.8)         {
    return account * (pctPerMaand / 100) * split;
  }

  window.__weChart = { rng, series, fibNiveaus, spiegel, hoofdSet, ltfSet, fragment, bereik, miniReeks, ACCOUNTGROOTTES, rOver100, quitte, fundedMaand };
})();
