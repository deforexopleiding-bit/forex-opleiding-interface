// api/follow-up-backfill-contacts.js
//
// POST — backfill lead_email + lead_phone voor bestaande appointments
// zonder contactgegevens, via GHL API lookup op lead_ghl_contact_id.
//
// Auth: alleen super_admin
// Gebruik: eenmalig aanroepen via curl of dashboard na migratie

import { createClient } from '@supabase/supabase-js';
import { fetchGhlContact } from './_lib/ghl-contact.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Ongeldige token' });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  // Haal appointments op zonder email én/of phone, maar mét GHL contact ID
  const { data: appts, error: fetchErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_ghl_contact_id, lead_email, lead_phone')
    .not('lead_ghl_contact_id', 'is', null)
    .or('lead_email.is.null,lead_phone.is.null');

  if (fetchErr) {
    return res.status(500).json({ error: fetchErr.message });
  }

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const appt of (appts || [])) {
    const contact = await fetchGhlContact(appt.lead_ghl_contact_id);
    if (!contact) {
      errors++;
      continue;
    }

    const update = {};
    if (!appt.lead_email && contact.email) update.lead_email = contact.email;
    if (!appt.lead_phone && contact.phone) update.lead_phone = contact.phone;

    if (Object.keys(update).length === 0) {
      skipped++;
      continue;
    }

    const { error: updateErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .update(update)
      .eq('id', appt.id);

    if (updateErr) {
      console.error('[backfill-contacts] update fout:', appt.id, updateErr.message);
      errors++;
    } else {
      updated++;
    }
  }

  console.log('[backfill-contacts] totaal:', appts?.length || 0, 'updated:', updated, 'skipped:', skipped, 'errors:', errors);
  return res.status(200).json({
    totaal: appts?.length || 0,
    updated,
    skipped,
    errors,
  });
}
