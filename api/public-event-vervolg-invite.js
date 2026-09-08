// api/public-event-vervolg-invite.js
//
// STAP 2 — server-to-server invite-trigger. De dfo-website gate-book roept dit
// (fail-soft) aan i.p.v. de losse bevestigingsmail, zodat de toegelatene meteen
// de Stap-2-uitnodiging krijgt (mail + WhatsApp) om z'n inschrijving definitief
// te maken. x-internal-token == OPSTARTSESSIE_SECRET.
//
// POST { attendee_id }
// Response 200 { ok, mail, whatsapp } | 400/401/404/503

import { sendEventAttendeeVervolg } from './_lib/events-vervolg-invite.js';
import { isUuid } from './_lib/event-vervolg.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const verwacht = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if ((req.headers['x-internal-token'] || null) !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const attendeeId = String(body.attendee_id || '').trim();
  if (!isUuid(attendeeId)) return res.status(400).json({ error: 'attendee_id (uuid) vereist' });

  const result = await sendEventAttendeeVervolg({ attendeeId });
  if (!result.ok && result.error) {
    // Fail-soft naar de caller: 200 met ok:false zodat de boeking nooit hierop breekt.
    return res.status(200).json({ ok: false, error: result.error });
  }
  return res.status(200).json({ ok: true, mail: result.mail, whatsapp: result.whatsapp });
}
