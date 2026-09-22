// api/support-actie-aanmaken.js
//
// POST — een medewerker legt zelf een actie vast bij een gesprek.
//
// Bestaat omdat de bot lang niet alles voorstelt. Wie tijdens een gesprek
// bedenkt dat de mentor moet bellen, wil dat kunnen vastleggen zonder naar
// Takenbeheer te springen en daar de context opnieuw op te schrijven.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOORTEN = ['LMS_UITNODIGING_OPNIEUW', 'LMS_PROVISIONING_OPNIEUW', 'BETALINGSAFSPRAAK', 'MENTOR_CONTACT', 'HANDMATIG'];

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'POST')) return;

  const staff = await staffUit(req, res, 'support.reply');
  if (!staff) return;

  const gesprekId = String(req.body?.gesprek_id || '');
  const soort = SOORTEN.includes(req.body?.soort) ? req.body.soort : null;
  const omschrijving = String(req.body?.omschrijving || '').trim().slice(0, 500);

  if (!UUID_RE.test(gesprekId)) return res.status(400).json({ error: 'Ongeldig gesprek_id' });
  if (!soort) return res.status(400).json({ error: 'Onbekend soort actie' });
  if (omschrijving.length < 5) return res.status(400).json({ error: 'Beschrijf kort wat er moet gebeuren' });

  try {
    const { data: gesprek } = await supabaseAdmin
      .from('support_gesprekken').select('id, customer_id, onboarding_id').eq('id', gesprekId).maybeSingle();
    if (!gesprek) return res.status(404).json({ error: 'Gesprek niet gevonden' });

    const { data, error } = await supabaseAdmin.from('support_acties').insert({
      gesprek_id: gesprekId,
      soort,
      omschrijving,
      payload: { customer_id: gesprek.customer_id, onboarding_id: gesprek.onboarding_id },
      voorgesteld_door: staff.user.id,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);

    return res.status(201).json({ actie: data });
  } catch (e) {
    console.error('[support-actie-aanmaken] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon de actie niet vastleggen.' });
  }
}
