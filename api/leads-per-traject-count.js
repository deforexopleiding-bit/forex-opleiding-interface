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
import { periodRange, nlDayStart, nlDayEndExclusive } from './_lib/nl-period.js';
import { computeLeadsByTraject } from './_lib/leads-per-traject-compute.js';

// Vertaal de publieke period-param (today|week|month|all) naar een NL-tijdzone-
// aware UTC-range via nl-period.js. VOORHEEN bucketten we op de server-lokale
// (=UTC op Vercel) kalenderdag: `since = now.getFullYear()-getMonth()-getDate()`
// + '.gte(aangemaakt, since+"T00:00:00")' zonder offset → een lead van 00:37 NL
// (= 22:37 UTC de dag ervoor) viel in de UTC-dag ervoor en telde niet mee in
// "vandaag". Nu bepalen we [start, eind) in Europe/Amsterdam en zetten die om
// naar exacte UTC-instants (DST-correct). 'all' → geen range.
function rangeForPeriod(p) {
  if (p === 'today') return periodRange('dag');
  if (p === 'week')  return periodRange('week');
  if (p === 'month') return periodRange('maand');
  return null; // 'all'
}

// 2026-08-24 custom-range support: bouw een range-object uit YYYY-MM-DD-strings.
// Return null als input ongeldig. NL-tz-aware zodat "gisteren" niet een dag
// verschuift. Bij from==to → alleen die ene dag (00:00 t/m 24:00-exclusief).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function rangeForCustom(fromStr, toStr) {
  if (!ISO_DATE_RE.test(fromStr) || !ISO_DATE_RE.test(toStr)) return null;
  const start = nlDayStart(new Date(fromStr + 'T12:00:00Z'));
  const endExclusive = nlDayEndExclusive(new Date(toStr + 'T12:00:00Z'));
  if (endExclusive <= start) return null;
  return { start, endExclusive, label: fromStr };
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
    // 2026-08-24 custom-range: ?from=YYYY-MM-DD&to=YYYY-MM-DD overrules period.
    const rawFrom = String(q.from || '').trim();
    const rawTo   = String(q.to   || '').trim();
    const customRange = rangeForCustom(rawFrom, rawTo);
    const range = customRange || rangeForPeriod(period);
    const since = range ? range.label : null;      // NL-kalenderdatum van start (response-compat)
    const debug = String(q.debug || '') === '1';

    // 2026-08-25: hoofd-compute verhuisd naar _lib/leads-per-traject-compute.js
    // zodat tv-display-metrics en andere dashboards dezelfde definitie
    // hergebruiken zonder self-HTTP-loops. Response-shape identiek.
    const out = await computeLeadsByTraject({ supabaseAdmin, range });
    out.period = period;
    out.since  = since;

    // Debug-mode: extra raw/uniek-tellingen (blijft in endpoint want puur
    // diagnose — helper hoeft die niet te leveren).
    if (debug) {
      let qy = supabaseAdmin
        .from('leads')
        .select('traject, email, afwijzer')
        .is('verwijderd_op', null)
        .limit(50000);
      if (range) {
        qy = qy
          .gte('aangemaakt', range.start.toISOString())
          .lt('aangemaakt', range.endExclusive.toISOString());
      }
      const { data: dbgData } = await qy;
      const rows = dbgData || [];
      const rawBy = Object.create(null); let rawTotal = 0;
      const uniekBy = Object.create(null); let uniekTotal = 0;
      const seenEmails = new Set();
      for (const row of rows) {
        const t = (row && row.traject != null) ? String(row.traject) : '';
        const em = row?.email || '';
        rawTotal += 1;
        if (t) rawBy[t] = (rawBy[t] || 0) + 1;
        const emKey = String(em || '').toLowerCase();
        if (emKey && !seenEmails.has(emKey)) {
          seenEmails.add(emKey);
          uniekTotal += 1;
          if (t) uniekBy[t] = (uniekBy[t] || 0) + 1;
        }
      }
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
