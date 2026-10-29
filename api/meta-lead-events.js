// api/meta-lead-events.js
//
// Overzicht voor het Meta-koppeling-paneel: recente Lead-events uit
// meta_lead_events + dagtellers (vandaag, Europe/Amsterdam). Permission: leads.view.
//
//   GET → { tellers: { verstuurd, geen_toestemming, al_geteld },
//           events: [ { bron, status, skip_reason, event_id, match, match_totaal,
//                       aangemaakt } ] }
//
// READ-ONLY.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { nlDayStart, nlDayEndExclusive } from './_lib/nl-period.js';

const LIMIET = 60;

// Aantal aanwezige matchsleutels / totaal (voor de match-kwaliteit-badge).
function matchTelling(mk) {
  if (!mk || typeof mk !== 'object') return { match: null, match_totaal: null };
  const keys = Object.keys(mk);
  if (!keys.length) return { match: null, match_totaal: null };
  return { match: keys.filter((k) => mk[k] === true).length, match_totaal: keys.length };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    // Recente events.
    const { data: rijen, error } = await supabaseAdmin
      .from('meta_lead_events')
      .select('bron, status, skip_reason, event_id, match_keys, aangemaakt')
      .order('aangemaakt', { ascending: false })
      .limit(LIMIET);
    if (error) throw error;

    const events = (rijen || []).map((r) => {
      const { match, match_totaal } = matchTelling(r.match_keys);
      return {
        bron: r.bron || null,
        status: r.status,
        skip_reason: r.skip_reason || null,
        event_id: r.event_id,
        match, match_totaal,
        aangemaakt: r.aangemaakt,
      };
    });

    // Dagtellers (vandaag NL).
    const startIso = nlDayStart().toISOString();
    const endIso = nlDayEndExclusive().toISOString();
    const { data: vandaag } = await supabaseAdmin
      .from('meta_lead_events')
      .select('status, skip_reason')
      .gte('aangemaakt', startIso).lt('aangemaakt', endIso)
      .limit(5000);
    const tellers = { verstuurd: 0, geen_toestemming: 0, al_geteld: 0 };
    for (const r of vandaag || []) {
      if (r.status === 'sent') tellers.verstuurd += 1;
      else if (r.skip_reason === 'geen advertentie-toestemming') tellers.geen_toestemming += 1;
      else if (r.skip_reason === 'al geteld (dedup)') tellers.al_geteld += 1;
    }

    return res.status(200).json({ tellers, events });
  } catch (e) {
    console.error('[meta-lead-events]', e?.message || e);
    return res.status(500).json({ error: 'Kon events niet laden' });
  }
}
