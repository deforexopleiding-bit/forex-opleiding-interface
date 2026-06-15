// api/events-attendee-send-invite.js
//
// POST → stuur een deelnemer z'n persoonlijke keuze-link via WhatsApp
// (Simone-lijn) + e-mail. Operator-actie vanuit events-detail Aanwezigen-tab.
// Beide kanalen onafhankelijk: één faal-tak blokkeert de andere niet.
//
// Permission: events.attendee.edit (bestaande key; operatie op bestaande rij).
//
// Body (JSON):
//   { attendee_id: uuid }
//
// Response 200 — beide kanalen los gerapporteerd:
//   {
//     attendee_id, event_id, keuze_link,
//     mail     : { ok, skipped?, reason?, error? },
//     whatsapp : { ok, skipped?, reason?, message_id?, meta_wamid?, error? }
//   }
//
// Errors:
//   400  attendee_id ontbreekt / ongeldige uuid
//   401  geen sessie
//   403  geen events.attendee.edit rechten
//   404  attendee niet gevonden / event niet gevonden
//   500  database-fout / invite-flow fout
//
// De daadwerkelijke invite-flow zit in api/_lib/events-invite.js zodat
// events-attendee-add.js en events-attendee-move.js hem ook kunnen
// hergebruiken (optioneel, na succesvolle insert).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendEventAttendeeInvite } from './_lib/events-invite.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth + RBAC.
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.edit)' });
  }

  // Body parse.
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt.' });
  const attendeeId = typeof body.attendee_id === 'string' ? body.attendee_id.trim() : '';
  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist.' });
  }

  try {
    // Pre-check zodat 404 helder is voordat helper gaat draaien.
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee fetch: ' + attErr.message);
    if (!attendee) return res.status(404).json({ error: 'Deelnemer niet gevonden.' });

    const result = await sendEventAttendeeInvite({
      attendeeId,
      sentByUserId: user.id,
    });

    if (!result.ok && result.error && !result.mail && !result.whatsapp) {
      return res.status(500).json({ error: result.error });
    }

    return res.status(200).json({
      attendee_id : attendeeId,
      event_id    : attendee.event_id,
      keuze_link  : result.keuze_link,
      mail        : result.mail,
      whatsapp    : result.whatsapp,
    });
  } catch (e) {
    console.error('[events-attendee-send-invite] fatal:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
