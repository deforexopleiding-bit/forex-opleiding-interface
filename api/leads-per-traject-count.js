// api/leads-per-traject-count.js
// GET → aggregate leads-tellingen per traject-waarde.
// Gebruikt door dashboard-v2 "Leads per traject"-tegels + instellingen-v2 mk-bronnen.
//
// Ronde-31: canonieke definitie ná opschoning is
//   verwijderd_op IS NULL
//   AND afwijzer IS NOT TRUE
//   AND email NOT ILIKE '%test%'
//   AND email NOT ILIKE '%deforexopleiding%'
// Voorheen: alleen verwijderd_op-filter (leads_overzicht) → test-emails en
// afwijzers telden mee, aantal was te hoog.
//
// Bron gewisseld van view leads_overzicht → tabel leads. Reden: leads_overzicht
// bevat `afwijzer` niet in de view-select (staat wel op de onderliggende tabel).
// Direct van leads lezen is de simpelste weg zonder view-migratie.
//
// Query-params:
//   period   optioneel — 'today' | 'week' | 'month' | 'all' (default 'all')
//            week = maandag als weekstart (NL-conventie)
//   debug    '1' → zowel raw (oud) als schoon (nieuw) tellingen naast elkaar
//            in response, voor oud→nieuw meting per traject.
//
// Response (default):
//   { total, by_traject, traject_labels, all_traject_labels, period, since,
//     excluded: { test_email: N, afwijzer: N, both: N, total_excluded: N } }
//
// Response (?debug=1) — extra velden:
//   { ..., debug: { raw: { total, by_traject }, uniek: { total, by_traject } } }
//
// Permission: leads.view.
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayOfWeek(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : (1 - day);
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function sinceForPeriod(p) {
  const now = new Date();
  if (p === 'today') return isoDate(now);
  if (p === 'week')  return isoDate(mondayOfWeek(now));
  if (p === 'month') return isoDate(startOfMonth(now));
  return null; // 'all'
}

// Canonieke test/interne-domain filter — identiek toegepast in dashboard-tegel
// én instellingen-v2 mk-bronnen zodat beide bronnen dezelfde schone cijfers
// tonen. Bij uitbreiden: BEIDE plekken bijwerken (grep op TEST_EMAIL_MARKERS).
const TEST_EMAIL_MARKERS = ['test', 'deforexopleiding'];
function isTestEmail(e) {
  if (!e) return false;
  const s = String(e).toLowerCase();
  return TEST_EMAIL_MARKERS.some(m => s.includes(m));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    const q = req.query || {};
    const periodRaw = String(q.period || 'all').toLowerCase();
    const period = ['today', 'week', 'month', 'all'].includes(periodRaw) ? periodRaw : 'all';
    const since = sinceForPeriod(period);
    const debug = String(q.debug || '') === '1';

    // Bron: leads (raw tabel) — bevat afwijzer + email; view leads_overzicht doet dat niet.
    let qy = supabaseAdmin
      .from('leads')
      .select('traject, email, afwijzer')
      .is('verwijderd_op', null)
      .limit(50000);
    if (since) qy = qy.gte('aangemaakt', since + 'T00:00:00');
    const { data, error } = await qy;
    if (error) throw new Error('leads: ' + error.message);

    const rows = data || [];

    // Raw (oude definitie: alleen verwijderd_op-filter) — voor debug/oud→nieuw.
    const rawBy = Object.create(null);
    let rawTotal = 0;
    // Schoon (nieuwe canonieke definitie).
    const cleanBy = Object.create(null);
    let cleanTotal = 0;
    // Uniek per lowercase(email) — voor debug-diagnose (dedup-signaal).
    const uniekBy = Object.create(null);
    let uniekTotal = 0;
    const seenEmails = new Set();
    // Exclusie-tellers voor transparantie in mk-bronnen.
    let excTest = 0;
    let excAfwijzer = 0;
    let excBoth = 0;

    for (const row of rows) {
      const t = (row && row.traject != null) ? String(row.traject) : '';
      const em = row?.email || '';
      const isTest = isTestEmail(em);
      const isRej  = row?.afwijzer === true;
      rawTotal += 1;
      if (t) rawBy[t] = (rawBy[t] || 0) + 1;
      const emKey = String(em || '').toLowerCase();
      if (emKey && !seenEmails.has(emKey)) {
        seenEmails.add(emKey);
        uniekTotal += 1;
        if (t) uniekBy[t] = (uniekBy[t] || 0) + 1;
      }
      if (isTest && isRej) excBoth += 1;
      else if (isTest)     excTest += 1;
      else if (isRej)      excAfwijzer += 1;
      if (isTest || isRej) continue; // uit schoon-set
      cleanTotal += 1;
      if (t) cleanBy[t] = (cleanBy[t] || 0) + 1;
    }
    const cleanLabels = Object.keys(cleanBy).sort((a, b) => a.localeCompare(b, 'nl'));

    // all_traject_labels: welke labels bestaan überhaupt (ná opschoning), ongeacht periode.
    // Voor tegel-consistentie: als een label 0 hits in period heeft maar wel bestaat, wordt hij nog getoond.
    let allLabels = cleanLabels;
    if (since) {
      const { data: allData, error: allErr } = await supabaseAdmin
        .from('leads')
        .select('traject, email, afwijzer')
        .is('verwijderd_op', null)
        .not('traject', 'is', null)
        .limit(50000);
      if (allErr) throw new Error('leads(all): ' + allErr.message);
      const set = new Set();
      for (const r of (allData || [])) {
        if (r?.afwijzer === true) continue;
        if (isTestEmail(r?.email)) continue;
        if (r?.traject) set.add(String(r.traject));
      }
      allLabels = [...set].sort((a, b) => a.localeCompare(b, 'nl'));
    }

    const out = {
      total: cleanTotal,
      by_traject: cleanBy,
      traject_labels: cleanLabels,
      all_traject_labels: allLabels,
      period,
      since,
      excluded: {
        test_email:     excTest,
        afwijzer:       excAfwijzer,
        both:           excBoth,
        total_excluded: excTest + excAfwijzer + excBoth,
      },
    };
    if (debug) {
      out.debug = {
        raw:   { total: rawTotal,   by_traject: rawBy },
        uniek: { total: uniekTotal, by_traject: uniekBy },
      };
    }
    return res.status(200).json(out);
  } catch (e) {
    console.error('[leads-per-traject-count]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
