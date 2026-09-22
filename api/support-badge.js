// api/support-badge.js
//
// GET → { count } — hoeveel gesprekken wachten er op ons?
//
// Licht gehouden: head-count, geen rijen over de lijn. Wordt elke minuut
// gepolld door de sidebar, dus elke kilobyte telt hier honderden keren per
// dag mee.
//
// Telt `wacht_op_ons`, niet "alles wat openstaat": een gesprek dat bij de
// klant ligt is geen werk voor ons, en een badge die altijd een getal toont
// wordt een badge die niemand meer ziet.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'GET')) return;

  const staff = await staffUit(req, res, 'support.module.access');
  if (!staff) return;

  try {
    const { count, error } = await supabaseAdmin
      .from('support_gesprekken')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'wacht_op_ons');
    if (error) throw new Error(error.message);
    return res.status(200).json({ count: count || 0 });
  } catch (e) {
    console.error('[support-badge] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon de teller niet ophalen.' });
  }
}
