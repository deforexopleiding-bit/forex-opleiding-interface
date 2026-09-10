// api/events-attendee-move.js
// POST -> verplaats een deelnemer naar een ander event.
//
// Permission: events.attendee.create (operatie creëert nieuwe rij op doel-event).
//
// Body (JSON):
//   {
//     attendee_id:     uuid (verplicht) — bron-deelnemer
//     target_event_id: uuid (verplicht) — doel-event
//     send_invite:     bool (optioneel, default false) — keuze-link sturen
//   }
//
// Flow:
//   1. Valideer bron-attendee + doel-event + niet-zelfde-event.
//   2. Capacity-check op doel-event (status 'aangemeld' = actief).
//   3. Email-duplicaat-check op doel-event (case-insensitive, partial unique).
//   4. INSERT nieuwe rij op doel-event met overgenomen identificerende velden
//      (first_name, last_name, email, phone, customer_id, deal_id,
//      assessment_response_id) + switched_from_event_id=source.event_id +
//      switched_at=now + status='aangemeld'.
//   5. Kopieer tags van bron naar nieuwe rij (best-effort).
//   6. UPDATE bron: status='switched_to_other_event', switched_at=now.
//   7. Audit-log entries op beide rijen.
//   8. Optioneel: invite (WhatsApp + e-mail) op nieuwe rij (niet-blokkerend).
//
// Response 201:
//   { source_attendee_id, new_attendee: {...row}, target_event_id,
//     invite?: { ok, mail?, whatsapp?, error? } }
//
// Errors:
//   400  body-validatie (UUIDs ontbreken / SAME_EVENT)
//   401  geen sessie
//   403  geen rechten
//   404  attendee of doel-event niet gevonden
//   409  SEATS_FULL / EMAIL_EXISTS / EVENT_ARCHIVED
//   500  database-fout

//
// ── DE VERPLAATSING ZELF STAAT IN _lib/event-attendee-move-core.js ───────
// Sinds de aanmeldkaart in Opvolging ook kan verplaatsen zijn er twee
// ingangen naar dezelfde handeling, met twee verschillende permissies. De
// stappen (validatie, capaciteit, e-mailduplicaat, insert, tags, bronrij,
// audit-log, capaciteitscascade) staan daarom op één plek. Dit bestand doet
// nog precies drie dingen: auth, de body lezen, en de uitkomst als HTTP
// teruggeven. Naar buiten toe is er niets veranderd.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { verplaatsDeelnemer } from './_lib/event-attendee-move-core.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.create'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.create)' });
  }

  const body = req.body || {};

  const uitkomst = await (async () => {
    try {
      return await verplaatsDeelnemer({
        attendeeId   : body.attendee_id ? String(body.attendee_id) : null,
        targetEventId: body.target_event_id ? String(body.target_event_id) : null,
        sendInvite   : body.send_invite === true || body.send_invite === 'true',
        userId       : user?.id || null,
      });
    } catch (e) {
      console.error('[events-attendee-move]', e.message);
      return { ok: false, status: 500, body: { error: e.message } };
    }
  })();

  return res.status(uitkomst.status).json(uitkomst.body);
}
