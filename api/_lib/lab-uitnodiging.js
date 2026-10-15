// api/_lib/lab-uitnodiging.js
//
// De sessiebalk en de slimme uitnodiging in het LMS ("Plan je sessie met
// Dave") schrijven gebeurtenissen in hlms_lab_lead_gebeurtenis:
//   uitnodiging_getoond  (sleutel = n-de keer, data.aanleiding)
//   uitnodiging_gesloten / uitnodiging_niet_nu   (sleutel = n)
//   uitnodiging_geboekt  (sleutel = n, of 'balk-<dag>'; data.bron)
//   balk_geklikt         (sleutel = dag)
// Hier worden die per hook (of campagne) opgeteld: uitnodiging → boeking.
// Zelfde regel als de funnel: een lead telt bij de hook van zijn EERSTE
// aanmelding, testaanmeldingen tellen niet.

export const UITNODIGING_SOORTEN = Object.freeze([
  'uitnodiging_getoond', 'uitnodiging_gesloten', 'uitnodiging_niet_nu', 'uitnodiging_geboekt', 'balk_geklikt',
]);

/** Waarom de uitnodiging openging, leesbaar. */
export const AANLEIDING_LABELS = Object.freeze({
  tweede_pagina: '2e pagina',
  tijd: '45 s op een pagina',
  nieuwe_dag: 'terug op een nieuwe dag',
  video: 'na een video',
  exit: 'wilde de pagina verlaten',
});

/** E-mail → sleutel van de eerste (niet-test) aanmelding. PURE. */
export function eersteSleutelPerEmail(aanmeldingen, per = 'hook') {
  const sleutelVan = (a) => (per === 'campagne' ? (a.utm_campaign || '(geen campagne)') : (a.hook || '(geen hook)'));
  const eerste = new Map();
  const gesorteerd = [...(aanmeldingen || [])].sort((x, y) => String(x.aangemaakt).localeCompare(String(y.aangemaakt)));
  for (const a of gesorteerd) {
    if (a.is_test) continue;
    const em = String(a.email || '').toLowerCase();
    if (em && !eerste.has(em)) eerste.set(em, sleutelVan(a));
  }
  return eerste;
}

const leeg = (sleutel) => ({ sleutel, leads: 0, gezien: 0, getoond: 0, via_uitnodiging: 0, geboekt_na: 0, balk_geklikt: 0, via_balk: 0 });

/**
 * Uitnodiging → boeking per hook. PURE.
 *
 * @param {object[]} aanmeldingen      lab_aanmeldingen-rijen
 * @param {Map}      lmsPerEmail       email → { labLead, geboekt? }
 * @param {Map}      gebeurtenissen    lab-lead-id → [{ soort, sleutel, data }]
 * @returns {{ rijen, totaal, perAanleiding }}
 *   gezien          = leads die de uitnodiging minstens één keer zagen
 *   getoond         = aantal keer getoond
 *   via_uitnodiging = leads die IN de uitnodiging boekten
 *   geboekt_na      = leads die de uitnodiging zagen en (hoe dan ook) boekten
 *   balk_geklikt / via_balk = hetzelfde voor de vaste balk
 *   perAanleiding   = { tijd: { getoond, geboekt }, … } (geboekt = in die uitnodiging)
 */
export function uitnodigingPerSleutel(aanmeldingen, lmsPerEmail, gebeurtenissen, per = 'hook') {
  const rijen = new Map();
  const perAanleiding = {};
  for (const [em, k] of eersteSleutelPerEmail(aanmeldingen, per)) {
    if (!rijen.has(k)) rijen.set(k, leeg(k));
    const r = rijen.get(k);
    r.leads++;
    const l = lmsPerEmail?.get(em) || {};
    const lijst = (l.labLead?.id && gebeurtenissen?.get(l.labLead.id)) || [];
    const aanleidingVan = new Map();
    let gezien = false; let viaUitn = false; let viaBalk = false; let balk = false;
    for (const g of lijst) {
      if (g.soort === 'uitnodiging_getoond') {
        gezien = true; r.getoond++;
        const a = g.data?.aanleiding || 'onbekend';
        aanleidingVan.set(String(g.sleutel), a);
        (perAanleiding[a] ||= { getoond: 0, geboekt: 0 }).getoond++;
      } else if (g.soort === 'balk_geklikt') balk = true;
    }
    for (const g of lijst) {
      if (g.soort !== 'uitnodiging_geboekt') continue;
      if (g.data?.bron === 'balk' || String(g.sleutel).startsWith('balk-')) { viaBalk = true; continue; }
      viaUitn = true;
      const a = aanleidingVan.get(String(g.sleutel)) || g.data?.bron || 'onbekend';
      (perAanleiding[a] ||= { getoond: 0, geboekt: 0 }).geboekt++;
    }
    const geboekt = !!(l.labLead?.sessie_geboekt_op || l.geboekt);
    if (gezien) r.gezien++;
    if (viaUitn) r.via_uitnodiging++;
    if (gezien && geboekt) r.geboekt_na++;
    if (balk) r.balk_geklikt++;
    if (viaBalk) r.via_balk++;
  }
  const lijst = [...rijen.values()].sort((a, b) => b.leads - a.leads || a.sleutel.localeCompare(b.sleutel));
  const totaal = lijst.reduce((t, r) => {
    for (const k of Object.keys(t)) if (k !== 'sleutel') t[k] += r[k];
    return t;
  }, leeg('Totaal'));
  return { rijen: lijst, totaal, perAanleiding };
}

/**
 * Lees de uitnodiging-gebeurtenissen voor een lijst lab-lead-id's.
 * Fail-soft: een LMS zonder de tabel geeft een lege Map.
 */
export async function leesUitnodigingGebeurtenissen(lms, leadIds) {
  const uit = new Map();
  const ids = [...new Set((leadIds || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await lms.from('hlms_lab_lead_gebeurtenis')
      .select('lead_id, soort, sleutel, data')
      .in('lead_id', ids.slice(i, i + 200))
      .in('soort', UITNODIGING_SOORTEN);
    if (error) { console.warn('[lab-uitnodiging] gebeurtenissen (soft):', error.message); return uit; }
    for (const g of data || []) {
      if (!uit.has(g.lead_id)) uit.set(g.lead_id, []);
      uit.get(g.lead_id).push(g);
    }
  }
  return uit;
}
