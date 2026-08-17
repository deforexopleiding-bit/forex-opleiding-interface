// api/leadsonderhoud-appointment-create.js
//
// BROK 2 FASE 2 (v=5) — thin wrapper rond api/_lib/create-appointment-from-lead.js
// zodat de Leadsonderhoud Gesprekken-tab een Zoom-afspraak kan inschieten
// voor een lead. Geen dubbele logica: alle GHL-contact-lookup + create-call
// zit al in de lib. Deze endpoint doet auth + input-validatie + error-mapping.
//
// Body:
//   lead_id         uuid    required
//   scheduledAt     ISO8601 required   (start van de call, in UTC of met TZ-offset)
//   durationMinutes int     optional   default 30
//
// Response:
//   200 { ok: true, ghl_appointment_id, follow_up_appointment_id,
//         zoom_meeting_id, zoom_join_url }
//   400 { error }                — validatie-fout (BAD_INPUT)
//   403 { error }                — geen rechten
//   404 { error }                — lead niet gevonden
//   422 { error, code: 'NO_GHL_CONTACT' }  — lead heeft nog geen GHL-contact
//                                            (frontend valt terug op Route B
//                                            "boekingslink versturen")
//   422 { error }                — GHL_CONFIG_MISSING (env-vars ontbreken)
//   502 { error, ghlStatus, ghlBody }  — GHL API-fout (via mapGhlError-tekst)
//
// Auth: leads.update (spiegelt lead-handmatig-toevoegen — wie een lead mag
// aanmaken/bijwerken mag ook een afspraak inschieten). afspraak_op op de
// lead-row wordt NIET direct door dit endpoint gezet — die synct binnen
// ~1 min via follow-up-ghl-appointment-poll cron.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createAppointmentForLead, mapGhlError } from './_lib/create-appointment-from-lead.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = String(body.lead_id || '').trim();
  const scheduledAt = String(body.scheduledAt || '').trim();
  const durationMinutes = Number.isFinite(Number(body.durationMinutes))
    ? Math.max(15, Math.min(120, Number(body.durationMinutes)))
    : 30;

  if (!UUID_RE.test(leadId))                return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
  if (!scheduledAt)                          return res.status(400).json({ error: 'scheduledAt vereist' });
  if (isNaN(new Date(scheduledAt).getTime())) return res.status(400).json({ error: 'scheduledAt ongeldig (verwacht ISO8601)' });

  // Lead-row ophalen (de lib heeft 'em nodig voor contact-lookup + naam voor
  // GHL-appointment-title).
  let lead;
  try {
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('id, naam, voornaam, achternaam, email, telefoon, customer_id, source_ref')
      .eq('id', leadId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Lead niet gevonden' });
    lead = data;
  } catch (e) {
    console.error('[ls-appt-create] lead-lookup:', e?.message || e);
    return res.status(500).json({ error: 'Kon lead niet ophalen' });
  }

  try {
    const result = await createAppointmentForLead({
      lead,
      scheduledAt,
      durationMinutes,
    });
    // afspraak_op wordt door de poll-cron gevuld (~1 min).
    return res.status(200).json({
      ok: true,
      ghl_appointment_id:       result.ghl_appointment_id       || result.ghl_id       || null,
      follow_up_appointment_id: result.follow_up_appointment_id || result.appointmentId || null,
      zoom_meeting_id:          result.zoom_meeting_id          || null,
      zoom_join_url:            result.zoom_join_url            || null,
    });
  } catch (e) {
    // Nette error-mapping — houdt frontend zijn eigen UX-fallback.
    if (e?.code === 'BAD_INPUT') {
      return res.status(400).json({ error: e.message || 'Ongeldige invoer' });
    }
    if (e?.code === 'NO_GHL_CONTACT') {
      // Frontend valt hierop terug op Route B (boekingslink versturen).
      return res.status(422).json({ code: 'NO_GHL_CONTACT', error: 'Lead heeft nog geen GHL-contact — verstuur eerst een boekingslink of maak eerst een GHL-contact aan.' });
    }
    if (e?.code === 'GHL_CONFIG_MISSING') {
      return res.status(422).json({ error: 'GHL-configuratie ontbreekt op de server (GHL_CALENDAR_ID / GHL_LOCATION_ID)' });
    }
    if (e?.code === 'GHL_API') {
      const nl = (typeof mapGhlError === 'function')
        ? mapGhlError(e.ghlStatus, e.ghlBody)
        : ('GHL API-fout (' + (e.ghlStatus || '?') + ')');
      return res.status(502).json({ error: nl || 'GHL API-fout', ghlStatus: e.ghlStatus || null });
    }
    console.error('[ls-appt-create] onbekende fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout bij aanmaken afspraak' });
  }
}
