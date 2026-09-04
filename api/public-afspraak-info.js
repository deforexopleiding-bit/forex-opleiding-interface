// api/public-afspraak-info.js
//
// Publiek (server-to-server via x-internal-token): token → overzicht van de
// afspraak voor de self-service-pagina. Lekt geen appointment_id/e-mail; enkel
// voornaam + tijd + of de afspraak nog te wijzigen is. De vrije slots voor het
// verzetten haalt de pagina via de bestaande /api/opstartsessie/free-slots-proxy.
//
// GET ?token=<uuid>
// 200 { ok, afspraak:{ voornaam, scheduled_at, duration_minutes, status, actief } }

import { checkSelfserviceSecret, haalAfspraakViaToken, voornaamVan } from './_lib/afspraak-selfservice.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const auth = checkSelfserviceSecret(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const token = (req.query?.token || '').toString();
  const r = await haalAfspraakViaToken(token);
  if (r.error) return res.status(r.status).json({ error: r.error });

  const a = r.appt;
  return res.status(200).json({
    ok: true,
    afspraak: {
      voornaam: voornaamVan(a.lead_name),
      scheduled_at: a.scheduled_at,
      duration_minutes: a.duration_minutes,
      status: a.status,
      actief: a.status === 'scheduled',   // alleen dan verzetbaar/annuleerbaar
    },
  });
}
