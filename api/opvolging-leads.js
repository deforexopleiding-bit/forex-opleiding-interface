// api/opvolging-leads.js
//
// GET → de potten van de tab 'Leads bellen'.
//
// Query: ?pot=terugbellen|verlopen|bezig|nieuw|wacht|later|ingepland|afgerond
//        ?pot=telling  → alleen aantallen per pot + dag- en weekstatistiek
//        ?pot=lijst&lijst=<uuid> → één APARTE LIJST: items = wie nu aan de
//                      beurt is, secties = de rest per pot, lijst = kop + telling
//
// Elke response draagt aparte_lijsten { beschikbaar, actief:[…], archief:[…] }
// voor de chips. De kaarten van een aparte lijst tellen nergens anders mee.
//
// Response 200:
//   { pot, vandaag, items:[...], aantallen:{pot:n}, badge, nieuw_heet,
//     niet_getoond:[{code,aantal,tekst}], dag:{...}, week:{...}, meldingen:[] }
//
// Leest leads, trial_warmte, lms_gebruikers, follow_up_appointments,
// opvolging_taken (beide lijsten: de leadkaarten én de telefoons van de
// daglijst, om dubbels te weren) en opvolging_pogingen. Schrijft niets.
// De beslissingen staan in api/_lib/opvolging-leads-pot.js.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { laadLeadsOverzicht } from './_lib/opvolging-leads-data.js';
import { POTTEN } from './_lib/opvolging-leads-pot.js';
import { isLijstId } from './_lib/opvolging-leads-lijsten.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'opvolging.leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.leads.view)' });
  }

  const q = req.query || {};
  const pot = String(q.pot || 'telling');
  if (pot !== 'telling' && pot !== 'lijst' && !POTTEN.includes(pot)) {
    return res.status(400).json({ error: 'onbekende pot', potten: POTTEN });
  }
  const lijstId = pot === 'lijst' ? String(q.lijst || '') : null;
  if (pot === 'lijst' && !isLijstId(lijstId)) return res.status(400).json({ error: 'onbekende lijst' });

  try {
    const o = await laadLeadsOverzicht(supabaseAdmin, Date.now(), { lijstId });
    const basis = {
      pot,
      vandaag: o.vandaag,
      aantallen: o.aantallen,
      badge: o.badge,
      nieuw_heet: o.nieuw_heet,
      nieuw_warm_of_heet: o.nieuw_warm_of_heet,
      // Nu bellen: aantal per sectie, wat dringend is, en wie op zijn
      // volgende belronde wacht (met het eerstvolgende moment).
      belrij: o.belrij,
      niet_getoond: o.niet_getoond,
      kandidaten: o.kandidaten,
      dag: o.dag,
      week: o.week,
      meldingen: o.meldingen,
      aparte_lijsten: o.aparte_lijsten,
    };
    if (pot === 'telling') return res.status(200).json(basis);
    if (pot === 'lijst') {
      const w = o.lijst_weergave;
      if (!w) return res.status(404).json({ error: 'Deze lijst bestaat niet (meer).' });
      return res.status(200).json({ ...basis, lijst: w.lijst, items: w.items, secties: w.secties, lijst_belrij: w.belrij });
    }
    return res.status(200).json({ ...basis, items: o.potten[pot] || [] });
  } catch (e) {
    console.error('[opvolging-leads]', pot, e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
