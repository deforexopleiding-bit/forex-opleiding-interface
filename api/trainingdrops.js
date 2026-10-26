// api/trainingdrops.js
//
// GET → alle wekelijkse training-drops (variant/bron 'training-<dd-mm-jj>',
// dfo-website /training/<dd-mm-jj> en training.deforexopleiding.nl/<dd-mm-jj>)
// met bezoekers, formulier gestart, leads, conversie en leads per kanaal, plus
// per drop de leadlijst. Nieuwste bovenaan. Voor de module Trainingdrops.
//
// Puur LEZEN uit bestaande tabellen: leads + funnel_events + (cadeau, dfo-website
// #132) follow_up_appointments met booking_source 'training-*' en de koppeling
// opstartsessie_submissions.appointment_id → lead_id. Geen schema, geen
// schrijfacties. Aggregatie in api/_lib/trainingdrops-compute.js.
//
// Response 200:
//   { drops:[{ variant, slug, label, datum, links:{live,site,pagina},
//       bezoekers, formulier_gestart, gegevens_ok, lead_ingediend, leads,
//       conversie_pct, formulier_pct, test_leads, test_sessies,
//       cadeau_getoond, cadeau_klik, calls, calls_gepland, calls_gehouden,
//       calls_no_show, calls_geannuleerd, leads_met_call, lead_call_pct,
//       kanalen:[{kanaal,label,bezoekers,leads,cadeau_klik,calls,gepland,gehouden,no_show,geannuleerd,lead_call_pct}],
//       leads_per_kanaal:[{kanaal,label,n}], bezoekers_per_kanaal:[…],
//       lead_lijst:[{id,naam,email,telefoon,status,campagne,huidige_bron,
//         bron_elders,kanaal,kanaal_label,aangemeld_op,lead_aangemaakt,
//         call:{scheduled_at,status,categorie,label}|null,test}] }],
//     totaal:{drops,bezoekers,formulier_gestart,leads,conversie_pct},
//     meta:{ tracking_actief, events_gelezen, afgekapt, kanaal_uitleg, leesfout, calls_fout } }
//
// FAIL-SOFT: bestaat funnel_events niet of faalt het lezen, dan komen de drops
// alleen uit de leads (bezoekers 0, tracking_actief false).
//
// Permission: leads.view (strict) — dezelfde als de leadlijst en funnel-stats.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { laadTrainingdrops } from './_lib/trainingdrops-laden.js';

export { PAGINA, MAX_EVENTS, TIJDBUDGET_MS } from './_lib/trainingdrops-laden.js';

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
    return res.status(200).json(await laadTrainingdrops(supabaseAdmin));
  } catch (e) {
    console.error('[trainingdrops]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
