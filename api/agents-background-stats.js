// api/agents-background-stats.js
//
// GET → 24u-tellers voor de "Op de achtergrond"-agents in de AI Agents-hub.
// Read-only, fail-soft per subquery. Geen writes.
//
//   gespreks_analyse: {
//     total_24h,          // count uit dunning_gesprek_analyse, geanalyseerd_op >= now-24h
//     afspraken_herkend, // count met afspraak_gemaakt='JA'
//   }
//   email_categorisatie: {
//     total_24h,          // count uit email_classifications, classified_at >= now-24h
//     high_confidence,    // count met confidence>=80 (accuracy-proxy)
//   }
//   lead_scoring: null    // geen tabel/bron in productie
//
// Permission: admin.joost_config (mirror van agents-hub-endpoints).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function sinceIso(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function safeCount(promise, label) {
  try {
    const res = await promise;
    if (res.error) { console.warn('[bg-stats] ' + label + ':', res.error.message); return 0; }
    return res.count || 0;
  } catch (e) {
    console.warn('[bg-stats] ' + label + ' exception:', e?.message || e);
    return 0;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const since24h = sinceIso(24);

  try {
    const [gaTotal, gaAfspraken, ecTotal, ecHigh] = await Promise.all([
      safeCount(
        supabaseAdmin.from('dunning_gesprek_analyse').select('customer_id', { count: 'exact', head: true }).gte('geanalyseerd_op', since24h),
        'ga-total-24h'
      ),
      safeCount(
        supabaseAdmin.from('dunning_gesprek_analyse').select('customer_id', { count: 'exact', head: true }).gte('geanalyseerd_op', since24h).eq('afspraak_gemaakt', 'JA'),
        'ga-afspraken-24h'
      ),
      safeCount(
        supabaseAdmin.from('email_classifications').select('email_uid', { count: 'exact', head: true }).gte('classified_at', since24h),
        'ec-total-24h'
      ),
      safeCount(
        supabaseAdmin.from('email_classifications').select('email_uid', { count: 'exact', head: true }).gte('classified_at', since24h).gte('confidence', 80),
        'ec-high-conf-24h'
      ),
    ]);

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      window_hours: 24,
      gespreks_analyse: {
        total_24h:         gaTotal,
        afspraken_herkend: gaAfspraken,
      },
      email_categorisatie: {
        total_24h:       ecTotal,
        high_confidence: ecHigh,
      },
      lead_scoring: null,
    });
  } catch (e) {
    console.error('[agents-background-stats]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
