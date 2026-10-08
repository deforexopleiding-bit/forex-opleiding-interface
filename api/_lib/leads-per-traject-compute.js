// api/_lib/leads-per-traject-compute.js
//
// Extract van de compute-logica in api/leads-per-traject-count.js zodat
// dashboards (v2-dashboard, tv-display-metrics) dezelfde definitie
// hergebruiken zonder self-HTTP-loops.
//
// Definitie (canoniek):
//   - verwijderd_op IS NULL
//   - afwijzer IS NOT TRUE  (voor "schone" tellingen)
//   - test-emails eruit (spam-filter, ook uit incl-afwijzer set)
//
// HERAANMELDINGEN (opt-in, 2026-10-08 — TV-bord): upsert_lead ontdubbelt op
// e-mailadres. Meldt een bestaande lead zich opnieuw aan, dan blijft
// `aangemaakt` de oude datum en telde de dag-telling hem niet. Met
// `heraanmeldingen: true` tellen ook leads met `laatste_aanmelding` binnen de
// periode mee — gezet bij ELKE aanmelding: funnels + site-formulier (/api/lead)
// en events (trigger op event_attendees), zie
// docs/sql-migrations/2026-10-08-leads-laatste-aanmelding.sql. Uniek per lead,
// zelfde filters (verwijderd_op, test-mail), bron-onafhankelijk.
// Bestaat de kolom nog niet (migratie niet gedraaid), dan valt het terug op
// funnel_events 'lead_ingediend' (alleen funnels). Fail-soft: lukt ook dat
// niet, dan blijft de oude telling staan.
//
// Retourneert dashboard-shape identiek aan het endpoint (velden matchen 1-op-1).

const TEST_EMAIL_MARKERS = ['test', 'deforexopleiding'];
function isTestEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const s = e.toLowerCase();
  return TEST_EMAIL_MARKERS.some(m => s.includes(m));
}

/**
 * @param {object} opts
 * @param {object} opts.supabaseAdmin - service-role client
 * @param {{start:Date, endExclusive:Date}|null} opts.range - null = 'all'
 * @param {boolean} [opts.skipAllLabels=false] - skip 50k all_traject_labels-scan
 *        (display-context gebruikt 'em niet — bespaart een tweede 50k-select).
 * @returns {Promise<object>}
 */
export async function computeLeadsByTraject({ supabaseAdmin, range = null, skipAllLabels = false, heraanmeldingen = false }) {
  let qy = supabaseAdmin.from('leads')
    .select('id, traject, email, afwijzer').is('verwijderd_op', null).limit(50000);
  if (range) {
    qy = qy.gte('aangemaakt', range.start.toISOString())
           .lt('aangemaakt', range.endExclusive.toISOString());
  }
  const { data, error } = await qy;
  if (error) throw new Error('leads: ' + error.message);
  const rows = data || [];
  const heraangemeld = (range && heraanmeldingen)
    ? await leesHeraanmeldingen(supabaseAdmin, range, new Set(rows.map((r) => r?.id).filter(Boolean)))
    : [];
  for (const h of heraangemeld) rows.push(h);

  const cleanBy = Object.create(null);
  let cleanTotal = 0;
  const inclAfwijzerBy = Object.create(null);
  let inclAfwijzerTotal = 0;
  let excTest = 0, excAfwijzer = 0, excBoth = 0;

  for (const row of rows) {
    const t = (row && row.traject != null) ? String(row.traject) : '';
    const em = row?.email || '';
    const isTest = isTestEmail(em);
    const isRej  = row?.afwijzer === true;
    if (isTest && isRej) excBoth += 1;
    else if (isTest)     excTest += 1;
    else if (isRej)      excAfwijzer += 1;
    if (!isTest) {
      inclAfwijzerTotal += 1;
      if (t) inclAfwijzerBy[t] = (inclAfwijzerBy[t] || 0) + 1;
    }
    if (isTest || isRej) continue;
    cleanTotal += 1;
    if (t) cleanBy[t] = (cleanBy[t] || 0) + 1;
  }

  const cleanLabels = Object.keys(cleanBy).sort((a, b) => a.localeCompare(b, 'nl'));

  // all_traject_labels — welke labels bestaan überhaupt (voor tegel-consistentie).
  // Skip in display-context: 50k-scan is verspilling als de caller geen tegel-
  // consistentie nodig heeft.
  let allLabels = cleanLabels;
  if (range && !skipAllLabels) {
    const { data: allData, error: allErr } = await supabaseAdmin
      .from('leads').select('traject, email, afwijzer')
      .is('verwijderd_op', null).not('traject', 'is', null).limit(50000);
    if (allErr) throw new Error('leads(all): ' + allErr.message);
    const set = new Set();
    for (const r of (allData || [])) {
      if (r?.afwijzer === true) continue;
      if (isTestEmail(r?.email)) continue;
      if (r?.traject) set.add(String(r.traject));
    }
    allLabels = [...set].sort((a, b) => a.localeCompare(b, 'nl'));
  }

  return {
    total: cleanTotal,
    by_traject: cleanBy,
    traject_labels: cleanLabels,
    all_traject_labels: allLabels,
    total_incl_afwijzer: inclAfwijzerTotal,
    by_traject_incl_afwijzer: inclAfwijzerBy,
    excluded: {
      test_email: excTest, afwijzer: excAfwijzer, both: excBoth,
      total_excluded: excTest + excAfwijzer + excBoth,
    },
    // Alleen gevuld met `heraanmeldingen: true`: bestaande leads die zich in de
    // periode opnieuw aanmeldden (zitten al in de tellingen hierboven).
    heraanmeldingen: heraangemeld.map((h) => ({
      id: h.id, voornaam: h.voornaam, achternaam: h.achternaam, email: h.email,
      traject: h.traject, soort: h.soort, ingediend_op: h.ingediend_op,
    })),
  };
}

/**
 * Leads die zich in de periode (opnieuw) aanmeldden maar NIET in de periode
 * zijn aangemaakt. Eén rij per lead. Primair `leads.laatste_aanmelding`;
 * zonder die kolom terugval op funnel_events. Fail-soft → [].
 */
async function leesHeraanmeldingen(supabaseAdmin, range, alGeteld) {
  const viaKolom = await viaLaatsteAanmelding(supabaseAdmin, range, alGeteld);
  if (viaKolom) return viaKolom;
  return viaFunnelEvents(supabaseAdmin, range, alGeteld);
}

/** null = kolom (nog) niet bruikbaar → caller valt terug. */
async function viaLaatsteAanmelding(supabaseAdmin, range, alGeteld) {
  try {
    const { data, error } = await supabaseAdmin.from('leads')
      .select('id, traject, email, afwijzer, voornaam, achternaam, soort, laatste_aanmelding')
      .is('verwijderd_op', null)
      .gte('laatste_aanmelding', range.start.toISOString())
      .lt('laatste_aanmelding', range.endExclusive.toISOString())
      .limit(50000);
    if (error) {
      console.warn('[leads-per-traject] laatste_aanmelding niet bruikbaar, terugval op funnel_events:', error.message);
      return null;
    }
    return (data || [])
      .filter((l) => l?.id && !alGeteld.has(l.id))
      .map(({ laatste_aanmelding, ...l }) => ({ ...l, ingediend_op: laatste_aanmelding }));
  } catch (e) {
    console.warn('[leads-per-traject] laatste_aanmelding exception, terugval:', e?.message || e);
    return null;
  }
}

/** Terugval (vóór de migratie): funnel_events 'lead_ingediend' met lead_id. */
async function viaFunnelEvents(supabaseAdmin, range, alGeteld) {
  try {
    const { data: ev, error } = await supabaseAdmin.from('funnel_events')
      .select('lead_id, ts').eq('event_type', 'lead_ingediend').not('lead_id', 'is', null)
      .gte('ts', range.start.toISOString()).lt('ts', range.endExclusive.toISOString())
      .order('ts', { ascending: true }).limit(5000);
    if (error) { console.warn('[leads-per-traject] heraanmeldingen (soft):', error.message); return []; }
    const eerste = new Map();
    for (const e of ev || []) if (e?.lead_id && !alGeteld.has(e.lead_id) && !eerste.has(e.lead_id)) eerste.set(e.lead_id, e.ts);
    const ids = [...eerste.keys()];
    const uit = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data: leads, error: lErr } = await supabaseAdmin.from('leads')
        .select('id, traject, email, afwijzer, voornaam, achternaam, soort')
        .in('id', ids.slice(i, i + 200)).is('verwijderd_op', null);
      if (lErr) { console.warn('[leads-per-traject] heraanmeldingen leads (soft):', lErr.message); return uit; }
      for (const l of leads || []) uit.push({ ...l, ingediend_op: eerste.get(l.id) });
    }
    return uit;
  } catch (e) {
    console.warn('[leads-per-traject] heraanmeldingen exception (soft):', e?.message || e);
    return [];
  }
}
