// api/_lib/weekeditie-data.js
//
// Contentmachine 2.0, fase 5/§6 — data per drop: bezoekers, leads, conversie, calls en per
// kanaal (src) uit de Trainingdrops-logica, plus de top-3 meest gebruikte blokken uit de
// nieuwe funnel-events van de Weekeditie (dfo-website lib/weekeditie-meting.ts):
//   blok_bekeken (vraag_id = bloktype, stap_nr = positie) · quiz_antwoord · slider_gebruikt · replay_gestart
// PUUR: de lezing gebeurt in api/contentmachine/data.js.

export const BLOK_EVENTS = Object.freeze(['blok_bekeken', 'quiz_antwoord', 'slider_gebruikt', 'replay_gestart']);
const GEBRUIK = new Set(['quiz_antwoord', 'slider_gebruikt', 'replay_gestart']);

/**
 * Per bloktype: unieke sessies die het blok zagen en die het gebruikten. Top `n` op gebruik,
 * dan op bekeken. events = [{ session_id, event_type, vraag_id }]. → [{ type, bekeken, gebruikt, pct }]
 */
export function topBlokken(events, n = 3) {
  const per = new Map();
  for (const e of events || []) {
    if (!e || !e.vraag_id || !e.session_id || !BLOK_EVENTS.includes(e.event_type)) continue;
    if (!per.has(e.vraag_id)) per.set(e.vraag_id, { bekeken: new Set(), gebruikt: new Set() });
    const p = per.get(e.vraag_id);
    if (e.event_type === 'blok_bekeken') p.bekeken.add(e.session_id);
    if (GEBRUIK.has(e.event_type)) { p.gebruikt.add(e.session_id); p.bekeken.add(e.session_id); }
  }
  return [...per.entries()]
    .map(([type, p]) => ({ type, bekeken: p.bekeken.size, gebruikt: p.gebruikt.size, pct: p.bekeken.size ? Math.round((p.gebruikt.size / p.bekeken.size) * 100) : 0 }))
    .sort((a, b) => b.gebruikt - a.gebruikt || b.bekeken - a.bekeken || a.type.localeCompare(b.type))
    .slice(0, n);
}

/** Slug uit de variant (training-dd-mm-jj[-n] of drop-dd-mm-jj[-n]). */
export const slugVanVariant = (v) => { const m = /^(?:training|drop)-(\d{2}-\d{2}-\d{2}(?:-\d)?)$/.exec(String(v || '')); return m ? m[1] : null; };

/**
 * De cijfers per drop-slug. drops = output van bouwTrainingdrops; blokEvents = de blok-events.
 * → { [slug]: { bezoekers, leads, conversie_pct, calls, calls_gehouden, cadeau_klik, kanalen, top_blokken } }
 */
export function dataPerDrop(drops = [], blokEvents = []) {
  const blokPer = new Map();
  for (const e of blokEvents) {
    const s = slugVanVariant(e && e.variant);
    if (!s) continue;
    if (!blokPer.has(s)) blokPer.set(s, []);
    blokPer.get(s).push(e);
  }
  const uit = {};
  const leeg = () => ({ bezoekers: 0, leads: 0, conversie_pct: 0, calls: 0, calls_gehouden: 0, cadeau_klik: 0, kanalen: [], top_blokken: [] });
  for (const d of drops) {
    const s = slugVanVariant(d.variant) || d.slug;
    if (!s) continue;
    const x = uit[s] || leeg();
    x.bezoekers += d.bezoekers || 0;
    x.leads += d.leads || 0;
    x.calls += d.calls || 0;
    x.calls_gehouden += d.calls_gehouden || 0;
    x.cadeau_klik += d.cadeau_klik || 0;
    x.kanalen = (d.kanalen || []).map((k) => ({ kanaal: k.kanaal, label: k.label, bezoekers: k.bezoekers || 0, leads: k.leads || 0, calls: k.calls || 0 }));
    x.conversie_pct = x.bezoekers ? Math.round((x.leads / x.bezoekers) * 1000) / 10 : 0;
    uit[s] = x;
  }
  for (const [s, ev] of blokPer) { (uit[s] = uit[s] || leeg()).top_blokken = topBlokken(ev); }
  return uit;
}
