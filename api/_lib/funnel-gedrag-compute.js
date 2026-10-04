// api/_lib/funnel-gedrag-compute.js
//
// Pure aggregatie van de GEDRAGSSIGNALEN uit funnel_events (dfo-website,
// migratie 2026-10-04-funnel-gedrag.sql): het WAAROM achter afhaken.
// Geen DB, geen IO — api/funnel-stats.js leest de rijen, deze functies tellen.
//
// Zes gedragstypes (meta per type, door de website al gevalideerd; hier nog
// eens defensief gelezen):
//   stap_verlaten   meta.duur_ms, meta.einde, meta.stap ('vraag'|'formulier')
//   scroll_diepte   meta.pct (0–100)
//   veld_laatst     meta.veld
//   validatie_fout  meta.veld, meta.type
//   rage_click      meta.doel, meta.aantal
//   afhaakpunt      meta.fase, meta.veld?  (+ stap_nr op de rij)
// Daarnaast leest de endpoint vraag_beantwoord (terugval voor tijd per vraag)
// en overgeslagen (einde van de boekstap).
//
// Alleen veldNAMEN en enums — er staan geen waarden in deze rijen.

export const GEDRAG_EVENT_TYPES = Object.freeze([
  'stap_verlaten', 'scroll_diepte', 'veld_laatst', 'validatie_fout', 'rage_click', 'afhaakpunt',
]);
/** Wat de endpoint naast de funnel-events ophaalt (mét meta). */
export const GEDRAG_LEES_TYPES = Object.freeze([...GEDRAG_EVENT_TYPES, 'vraag_beantwoord', 'overgeslagen']);

const GEDRAG_SET = new Set(GEDRAG_EVENT_TYPES);
const VELDEN = new Set(['voornaam', 'achternaam', 'email', 'telefoon', 'akkoord', 'overig']);
const VALIDATIE_TYPES = new Set(['leeg', 'ongeldig', 'geen_landcode', 'niet_aangevinkt']);
const FASES = ['landing', 'formulier', 'quiz', 'beoordeling', 'toelating'];
const FASE_SET = new Set(FASES);
const DOEL_RE = /^[a-z][a-z0-9]{0,9}([#.][a-z0-9_-]{1,40})?$/;
export const MAX_DUUR_MS = 30 * 60 * 1000;
export const TOP_N = 8;

export const SCROLL_BUCKETS = Object.freeze([
  { label: '0–24%', van: 0, tot: 24 },
  { label: '25–49%', van: 25, tot: 49 },
  { label: '50–74%', van: 50, tot: 74 },
  { label: '75–99%', van: 75, tot: 99 },
  { label: '100%', van: 100, tot: 100 },
]);

function tsMs(v) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : NaN;
}
function pct(teller, noemer) {
  if (!noemer) return null;
  return Math.round((teller / noemer) * 1000) / 10;
}
/** Seconden met 1 decimaal; null als er niets is. */
function sec(ms) {
  return ms == null || !Number.isFinite(ms) ? null : Math.round(ms / 100) / 10;
}
export function mediaan(waarden) {
  const a = (waarden || []).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function gemiddelde(waarden) {
  const a = (waarden || []).filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function metaVan(e) {
  return e && e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta) ? e.meta : {};
}
function veldVan(x) {
  if (typeof x !== 'string' || !x) return null;
  const v = x.toLowerCase();
  return VELDEN.has(v) ? v : 'overig';
}
const versieVan = (e) => (e.quiz_versie == null || e.quiz_versie === '' ? 'onbekend' : String(e.quiz_versie));
const stapVan = (e) => { const n = Number(e.stap_nr); return Number.isInteger(n) && n >= 1 ? n : null; };
const sleutel = (versie, stap) => versie + '|' + stap;
function teller(map, k) { map.set(k, (map.get(k) || 0) + 1); }

/**
 * Gedrag voor één variant.
 * @param {Array} events        funnel-events van de variant (o.a. vraag_getoond, lead_ingediend, geboekt)
 * @param {Array} gedragEvents  rijen met event_type in GEDRAG_LEES_TYPES, mét meta
 */
export function bouwGedrag({ events = [], gedragEvents = [] } = {}) {
  const leadSessies = new Set();
  const geboektSessies = new Set();
  // versie|stap → sid → eerste ts van vraag_getoond
  const getoond = new Map();
  for (const e of events) {
    if (!e || !e.session_id) continue;
    if (e.event_type === 'lead_ingediend') leadSessies.add(e.session_id);
    if (e.event_type === 'geboekt') geboektSessies.add(e.session_id);
    if (e.event_type !== 'vraag_getoond') continue;
    const stap = stapVan(e);
    if (stap === null) continue;
    const k = sleutel(versieVan(e), stap);
    if (!getoond.has(k)) getoond.set(k, new Map());
    const t = tsMs(e.ts);
    const per = getoond.get(k);
    if (Number.isFinite(t) && (!per.has(e.session_id) || t < per.get(e.session_id))) per.set(e.session_id, t);
  }

  const beantwoord = new Map();     // versie|stap → sid → eerste ts
  const stapDuur = new Map();       // versie|stap → sid → som duur_ms (stap_verlaten, vraag)
  const formulierDuur = new Map();  // sid → som duur_ms
  const formulierVerstuurd = new Set();
  const scrollMax = new Map();      // sid → max pct
  const validatie = new Map();      // veld|type → { sessies:Set, keer }
  const rage = new Map();           // doel → { sessies:Set, klikken }
  const veldMomenten = new Map();   // sid → { t, veld } (laatste)
  const afhaak = new Map();         // sid → { t, fase, stap_nr } (laatste)
  const overgeslagen = new Set();
  let gedragAantal = 0;

  for (const e of gedragEvents) {
    if (!e || !e.session_id) continue;
    const m = metaVan(e);
    const sid = e.session_id;
    const t = tsMs(e.ts);
    if (GEDRAG_SET.has(e.event_type)) gedragAantal += 1;
    switch (e.event_type) {
      case 'vraag_beantwoord': {
        const stap = stapVan(e);
        if (stap === null || !Number.isFinite(t)) break;
        const k = sleutel(versieVan(e), stap);
        if (!beantwoord.has(k)) beantwoord.set(k, new Map());
        const per = beantwoord.get(k);
        if (!per.has(sid) || t < per.get(sid)) per.set(sid, t);
        break;
      }
      case 'overgeslagen': overgeslagen.add(sid); break;
      case 'stap_verlaten': {
        const duur = Number(m.duur_ms);
        if (!Number.isFinite(duur) || duur < 0) break;
        const d = Math.min(duur, MAX_DUUR_MS);
        if (m.stap === 'formulier') {
          formulierDuur.set(sid, (formulierDuur.get(sid) || 0) + d);
          if (m.einde === 'verstuurd') formulierVerstuurd.add(sid);
          break;
        }
        const stap = stapVan(e);
        if (stap === null) break;
        const k = sleutel(versieVan(e), stap);
        if (!stapDuur.has(k)) stapDuur.set(k, new Map());
        const per = stapDuur.get(k);
        per.set(sid, (per.get(sid) || 0) + d);
        break;
      }
      case 'scroll_diepte': {
        const p = Number(m.pct);
        if (!Number.isFinite(p)) break;
        const v = Math.min(100, Math.max(0, Math.round(p)));
        if (!scrollMax.has(sid) || v > scrollMax.get(sid)) scrollMax.set(sid, v);
        break;
      }
      case 'validatie_fout': {
        const veld = veldVan(m.veld);
        const type = VALIDATIE_TYPES.has(m.type) ? m.type : null;
        if (!veld || !type) break;
        const k = veld + '|' + type;
        if (!validatie.has(k)) validatie.set(k, { veld, type, sessies: new Set(), keer: 0 });
        const r = validatie.get(k);
        r.sessies.add(sid); r.keer += 1;
        break;
      }
      case 'rage_click': {
        const doel = typeof m.doel === 'string' ? m.doel.toLowerCase() : '';
        if (!DOEL_RE.test(doel)) break;
        const aantal = Math.max(0, Math.min(50, Math.round(Number(m.aantal) || 0)));
        if (!rage.has(doel)) rage.set(doel, { doel, sessies: new Set(), klikken: 0 });
        const r = rage.get(doel);
        r.sessies.add(sid); r.klikken += aantal;
        break;
      }
      case 'veld_laatst':
      case 'afhaakpunt': {
        const veld = veldVan(m.veld);
        if (veld && Number.isFinite(t)) {
          const vorige = veldMomenten.get(sid);
          if (!vorige || t >= vorige.t) veldMomenten.set(sid, { t, veld });
        }
        if (e.event_type === 'afhaakpunt' && FASE_SET.has(m.fase) && Number.isFinite(t)) {
          const vorige = afhaak.get(sid);
          if (!vorige || t >= vorige.t) afhaak.set(sid, { t, fase: m.fase, stap_nr: stapVan(e) });
        }
        break;
      }
      default: break;
    }
  }

  // ── Tijd per vraag ──
  // Per sessie: som van stap_verlaten (ook afgehaakte stappen); zonder die
  // events de terugval vraag_getoond → eerste vraag_beantwoord (oudere data).
  const tijdPerVraag = new Map();   // versie|stap → { ... }
  const sleutels = new Set([...getoond.keys(), ...stapDuur.keys()]);
  for (const k of sleutels) {
    const [versie, stapTxt] = [k.slice(0, k.lastIndexOf('|')), k.slice(k.lastIndexOf('|') + 1)];
    const stap = Number(stapTxt);
    const perSessie = new Map();
    let viaStap = 0, viaTerugval = 0;
    for (const [sid, d] of (stapDuur.get(k) || new Map())) { perSessie.set(sid, d); viaStap += 1; }
    const gt = getoond.get(k) || new Map();
    const bt = beantwoord.get(k) || new Map();
    for (const [sid, tg] of gt) {
      if (perSessie.has(sid)) continue;
      const tb = bt.get(sid);
      if (tb == null || tb < tg) continue;
      const d = tb - tg;
      if (d <= MAX_DUUR_MS) { perSessie.set(sid, d); viaTerugval += 1; }
    }
    // Afhakers bij deze vraag: zagen 'm, maar niet de volgende (zelfde versie) en geen lead.
    const volgende = getoond.get(sleutel(versie, stap + 1)) || new Map();
    const afhakersDuur = [];
    for (const sid of gt.keys()) {
      if (volgende.has(sid) || leadSessies.has(sid)) continue;
      if (perSessie.has(sid)) afhakersDuur.push(perSessie.get(sid));
    }
    const alle = [...perSessie.values()];
    tijdPerVraag.set(k, {
      quiz_versie: versie, stap_nr: stap,
      tijd_n: alle.length,
      gem_tijd_s: sec(gemiddelde(alle)),
      mediaan_tijd_s: sec(mediaan(alle)),
      afhakers_n: afhakersDuur.length,
      afhakers_mediaan_s: sec(mediaan(afhakersDuur)),
      bron: viaStap && viaTerugval ? 'gemengd' : (viaStap ? 'stap_verlaten' : 'getoond_beantwoord'),
    });
  }

  // ── Scroll ──
  const scrollWaarden = [...scrollMax.values()];
  const scrollZonderLead = [...scrollMax].filter(([sid]) => !leadSessies.has(sid)).map(([, v]) => v);
  const scroll = {
    sessies: scrollWaarden.length,
    mediaan_pct: mediaan(scrollWaarden),
    mediaan_pct_zonder_lead: mediaan(scrollZonderLead),
    buckets: SCROLL_BUCKETS.map((b) => {
      const n = scrollWaarden.filter((v) => v >= b.van && v <= b.tot).length;
      return { label: b.label, van: b.van, tot: b.tot, sessies: n, pct: pct(n, scrollWaarden.length) };
    }),
  };

  // ── Afhakers: welk veld, welke fase ──
  // Een afhaakpunt telt alleen als de sessie daarna niet alsnog verder kwam:
  // vóór de boekstap = geen lead; in de boekstap = niet geboekt/overgeslagen.
  const echtAfgehaakt = (sid, fase) => (fase === 'toelating'
    ? !geboektSessies.has(sid) && !overgeslagen.has(sid)
    : !leadSessies.has(sid));
  const faseTel = new Map();
  const quizStapTel = new Map();
  let afhakers = 0;
  for (const [sid, a] of afhaak) {
    if (!echtAfgehaakt(sid, a.fase)) continue;
    afhakers += 1;
    teller(faseTel, a.fase);
    if (a.fase === 'quiz' && a.stap_nr) teller(quizStapTel, a.stap_nr);
  }
  const veldTel = new Map();
  let metVeld = 0;
  for (const [sid, v] of veldMomenten) {
    if (leadSessies.has(sid)) continue;
    metVeld += 1;
    teller(veldTel, v.veld);
  }

  const formulierWaarden = [...formulierDuur.values()];
  const formulierAfgehaakt = [...formulierDuur].filter(([sid]) => !formulierVerstuurd.has(sid)).map(([, d]) => d);

  return {
    beschikbaar: gedragAantal > 0,
    gedrag_events: gedragAantal,
    tijd_per_vraag: [...tijdPerVraag.values()].sort((a, b) =>
      a.quiz_versie.localeCompare(b.quiz_versie, 'nl', { numeric: true }) || a.stap_nr - b.stap_nr),
    formulier_tijd: {
      sessies: formulierWaarden.length,
      gem_s: sec(gemiddelde(formulierWaarden)),
      mediaan_s: sec(mediaan(formulierWaarden)),
      verstuurd: formulierVerstuurd.size,
      afgehaakt_mediaan_s: sec(mediaan(formulierAfgehaakt)),
    },
    scroll,
    validatie_top: [...validatie.values()]
      .map((r) => ({ veld: r.veld, type: r.type, sessies: r.sessies.size, keer: r.keer }))
      .sort((a, b) => b.sessies - a.sessies || b.keer - a.keer || a.veld.localeCompare(b.veld))
      .slice(0, TOP_N),
    laatste_veld: [...veldTel]
      .map(([veld, n]) => ({ veld, sessies: n, pct: pct(n, metVeld) }))
      .sort((a, b) => b.sessies - a.sessies || a.veld.localeCompare(b.veld)),
    afhaak_fases: FASES
      .map((f) => ({ fase: f, sessies: faseTel.get(f) || 0, pct: pct(faseTel.get(f) || 0, afhakers) }))
      .filter((r) => r.sessies > 0),
    afhaak_quiz_stappen: [...quizStapTel].map(([stap_nr, n]) => ({ stap_nr, sessies: n })).sort((a, b) => a.stap_nr - b.stap_nr),
    afhakers,
    rage_hotspots: [...rage.values()]
      .map((r) => ({ doel: r.doel, sessies: r.sessies.size, klikken: r.klikken }))
      .sort((a, b) => b.sessies - a.sessies || b.klikken - a.klikken || a.doel.localeCompare(b.doel))
      .slice(0, TOP_N),
  };
}

/** Zet de tijd per vraag op de bestaande afhaken_per_vraag-rijen (zelfde versie + stap). */
export function voegTijdToe(afhakenPerVraag, tijdPerVraag) {
  if (!Array.isArray(afhakenPerVraag)) return afhakenPerVraag;
  const per = new Map((tijdPerVraag || []).map((t) => [sleutel(t.quiz_versie, t.stap_nr), t]));
  for (const blok of afhakenPerVraag) {
    for (const v of blok.vragen || []) {
      const t = per.get(sleutel(blok.quiz_versie, v.stap_nr));
      v.gem_tijd_s = t ? t.gem_tijd_s : null;
      v.mediaan_tijd_s = t ? t.mediaan_tijd_s : null;
      v.tijd_n = t ? t.tijd_n : 0;
      v.afhakers_mediaan_s = t ? t.afhakers_mediaan_s : null;
    }
  }
  return afhakenPerVraag;
}
