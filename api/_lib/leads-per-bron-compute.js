// api/_lib/leads-per-bron-compute.js
//
// Aggregatie van leads-tellingen per `bron`-waarde (de funnel-/acquisitie-
// herkomst). 1-op-1 gespiegeld op leads-per-traject-compute.js, met traject → bron.
//
// Definitie (canoniek, identiek aan de per-traject-telling):
//   - verwijderd_op IS NULL
//   - afwijzer IS NOT TRUE  (voor "schone" tellingen)
//   - test-emails eruit (spam-filter)
//
// Retourneert shape parallel aan de per-traject-versie (velden bron i.p.v. traject).

const TEST_EMAIL_MARKERS = ['test', 'deforexopleiding'];
function isTestEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const s = e.toLowerCase();
  return TEST_EMAIL_MARKERS.some((m) => s.includes(m));
}

/**
 * @param {object} opts
 * @param {object} opts.supabaseAdmin - service-role client
 * @param {{start:Date, endExclusive:Date}|null} opts.range - null = 'all'
 * @returns {Promise<object>}
 */
export async function computeLeadsByBron({ supabaseAdmin, range = null }) {
  let qy = supabaseAdmin.from('leads')
    .select('bron, email, afwijzer').is('verwijderd_op', null).limit(50000);
  if (range) {
    qy = qy.gte('aangemaakt', range.start.toISOString())
           .lt('aangemaakt', range.endExclusive.toISOString());
  }
  const { data, error } = await qy;
  if (error) throw new Error('leads: ' + error.message);
  const rows = data || [];

  const cleanBy = Object.create(null);
  let cleanTotal = 0;
  const inclAfwijzerBy = Object.create(null);
  let inclAfwijzerTotal = 0;
  let excTest = 0, excAfwijzer = 0, excBoth = 0;

  for (const row of rows) {
    const b = (row && row.bron != null) ? String(row.bron) : '';
    const em = row?.email || '';
    const isTest = isTestEmail(em);
    const isRej  = row?.afwijzer === true;
    if (isTest && isRej) excBoth += 1;
    else if (isTest)     excTest += 1;
    else if (isRej)      excAfwijzer += 1;
    if (!isTest) {
      inclAfwijzerTotal += 1;
      if (b) inclAfwijzerBy[b] = (inclAfwijzerBy[b] || 0) + 1;
    }
    if (isTest || isRej) continue;
    cleanTotal += 1;
    if (b) cleanBy[b] = (cleanBy[b] || 0) + 1;
  }

  const cleanLabels = Object.keys(cleanBy).sort((a, b) => a.localeCompare(b, 'nl'));

  return {
    total: cleanTotal,
    by_bron: cleanBy,
    bron_labels: cleanLabels,
    total_incl_afwijzer: inclAfwijzerTotal,
    by_bron_incl_afwijzer: inclAfwijzerBy,
    excluded: {
      test_email: excTest, afwijzer: excAfwijzer, both: excBoth,
      total_excluded: excTest + excAfwijzer + excBoth,
    },
  };
}
